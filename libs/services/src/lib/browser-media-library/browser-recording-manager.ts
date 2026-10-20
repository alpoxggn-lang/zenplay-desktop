import type {
    ElectronBridgeErrorResult,
    RecordingProgramSnapshot,
    RecordingStartMetadata,
} from '@iptvnator/shared/interfaces';
import type {
    BrowserRecordingSnapshot,
    RecordingItem,
} from '../recordings.models';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import type { BrowserPrivateStorage } from './browser-private-storage';
import {
    BrowserRecordingPresence,
    type BrowserRecordingPresencePort,
    nextRecordingOwnerId,
} from './browser-recording-presence';
import { BrowserRecordingSession } from './browser-recording-session';

export class BrowserRecordingManager {
    private readonly ownerId = nextRecordingOwnerId();
    private active: BrowserRecordingSession | null = null;
    private message: string | null = null;
    private transitionKey: string | null = null;

    constructor(
        private readonly storage: BrowserPrivateStorage,
        private readonly supported: () => boolean,
        private readonly emitChange: () => void,
        private readonly presence: BrowserRecordingPresencePort = new BrowserRecordingPresence()
    ) {}

    async recoverInterrupted(): Promise<boolean> {
        let recoveredAny = false;
        const now = Date.now();
        for (const item of await this.storage.listRecordings()) {
            if (item.browserRemovalToken) {
                if ((item.browserRemovalStartedAt ?? now) <= now - 2 * 60_000) {
                    await this.storage.deleteFile(item.filePath);
                    recoveredAny =
                        (await this.storage.completeRecordingRemoval(
                            item.id,
                            item.browserRemovalToken
                        )) || recoveredAny;
                }
                continue;
            }
            if (item.status !== 'recording') continue;
            if ((item.browserLeaseUntil ?? 0) > now) continue;
            if (
                item.browserOwnerId &&
                (await this.presence.ownerObservable(
                    item.browserOwnerId,
                    item.id,
                    now
                ))
            ) {
                continue;
            }

            const file = item.filePath
                ? await this.storage.getFile(item.filePath)
                : null;
            const bytes = file?.size ?? 0;
            const empty = bytes === 0;
            const endedAt = new Date().toISOString();
            const recovered = await this.storage.recoverExpiredRecording(
                {
                    ...item,
                    status: empty ? 'failed' : 'interrupted',
                    fileSizeBytes: bytes,
                    fileAvailability: empty ? 'missing' : 'available',
                    browserOwnerId: undefined,
                    browserLeaseUntil: undefined,
                    errorMessage: empty
                        ? BROWSER_MEDIA_MESSAGES.recordingEmpty
                        : BROWSER_MEDIA_MESSAGES.recordingInterrupted,
                    endedAt,
                    updatedAt: endedAt,
                },
                item.browserOwnerId,
                now
            );
            if (!recovered) continue;
            recoveredAny = true;
            if (empty) await this.storage.deleteFile(item.filePath);
        }
        if (recoveredAny) this.emitChange();
        return recoveredAny;
    }

    async list(): Promise<RecordingItem[]> {
        await this.recoverInterrupted();
        const items = await this.storage.listRecordings();
        const currentItems = (
            await Promise.all(
                items.map(async (item) => {
                    if (item.browserRemovalToken) return null;
                    if (
                        !['completed', 'interrupted'].includes(item.status) ||
                        !item.filePath
                    ) {
                        return item;
                    }
                    const availability = (await this.storage.getFile(
                        item.filePath
                    ))
                        ? 'available'
                        : 'missing';
                    if (item.fileAvailability === availability) return item;
                    const updatedAt = new Date().toISOString();
                    const updated =
                        await this.storage.updateRecordingAvailability(
                            item,
                            availability,
                            updatedAt
                        );
                    if (!updated) {
                        const current = await this.storage.getRecording(
                            item.id
                        );
                        return current?.browserRemovalToken
                            ? null
                            : (current ?? null);
                    }
                    return {
                        ...item,
                        fileAvailability: availability,
                        updatedAt,
                    };
                })
            )
        ).filter((item): item is RecordingItem => !!item);
        for (const item of currentItems) {
            item.browserOwnedByThisTab =
                item.status === 'recording'
                    ? item.browserOwnerId === this.ownerId
                    : undefined;
        }
        return currentItems;
    }

    async get(id: number): Promise<RecordingItem | null> {
        return (await this.storage.getRecording(id)) ?? null;
    }

    snapshot(video?: HTMLVideoElement | null): BrowserRecordingSnapshot {
        const active = this.active;
        const ownsRecording = !!active && (!video || active.video === video);
        return {
            active: ownsRecording,
            elapsedSeconds: ownsRecording
                ? Math.max(
                      0,
                      Math.floor((Date.now() - active.startedAtMs) / 1000)
                  )
                : 0,
            message: this.message,
            transitionKey: this.transitionKey,
            owner: active?.video ?? null,
        };
    }

    async toggle(
        video: HTMLVideoElement,
        metadata: RecordingStartMetadata | null
    ): Promise<ElectronBridgeErrorResult> {
        try {
            if (this.active) {
                if (this.active.video !== video) {
                    return {
                        success: false,
                        error: BROWSER_MEDIA_MESSAGES.recordingAlreadyActive,
                    };
                }
                return this.active.stop();
            }
            if (!this.supported()) {
                return {
                    success: false,
                    error: BROWSER_MEDIA_MESSAGES.recordingUnsupported,
                };
            }
            const session = await BrowserRecordingSession.create(
                this.storage,
                video,
                metadata,
                this.ownerId,
                this.presence,
                {
                    emitChange: this.emitChange,
                    settled: (settled, result) =>
                        this.onSettled(settled, result),
                }
            );
            this.active = session;
            this.message = null;
            this.transitionKey = `${session.id}:recording`;
            const result = await session.start();
            if (!result.success) {
                if (this.active === session) this.active = null;
                this.message =
                    result.error ?? BROWSER_MEDIA_MESSAGES.recordingStartFailed;
                this.transitionKey = `${session.id}:failed`;
                this.emitChange();
            }
            return result;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            this.message = message;
            this.transitionKey = `error:${Date.now()}`;
            this.emitChange();
            return { success: false, error: message };
        }
    }

    async stop(id: number): Promise<ElectronBridgeErrorResult> {
        const active = this.active;
        if (!active || active.id !== id) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.recordingNotActive,
            };
        }
        return active.stop();
    }

    stopFor(video: HTMLVideoElement): Promise<ElectronBridgeErrorResult> {
        if (!this.active || this.active.video !== video) {
            return Promise.resolve({ success: true });
        }
        return this.active.stop();
    }

    async remove(id: number): Promise<ElectronBridgeErrorResult> {
        if (this.active?.id === id) await this.active.stop();
        const item = await this.storage.getRecording(id);
        if (
            item?.status === 'recording' &&
            item.browserOwnerId !== this.ownerId &&
            ((item.browserLeaseUntil ?? 0) > Date.now() ||
                (item.browserOwnerId &&
                    (await this.presence.ownerObservable(
                        item.browserOwnerId,
                        item.id,
                        Date.now()
                    ))))
        ) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.recordingActiveOtherTab,
            };
        }
        const token = nextRecordingOwnerId();
        const claim = await this.storage.claimRecordingRemoval(
            id,
            token,
            this.ownerId,
            Date.now()
        );
        if (claim.outcome === 'active-other-tab') {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.recordingActiveOtherTab,
            };
        }
        if (claim.outcome === 'missing') return { success: true };
        try {
            await this.storage.deleteFile(claim.item.filePath);
        } catch (error) {
            await this.storage.releaseRecordingRemoval(id, token);
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : BROWSER_MEDIA_MESSAGES.recordingFailed,
            };
        }
        const removed = await this.storage.completeRecordingRemoval(id, token);
        if (!removed) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.recordingNotFound,
            };
        }
        this.emitChange();
        return { success: true };
    }

    async updatePrograms(
        filePath: string,
        programs: RecordingProgramSnapshot[]
    ): Promise<ElectronBridgeErrorResult> {
        let item = (await this.list()).find(
            (recording) => recording.filePath === filePath
        );
        if (!item) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.recordingNotFound,
            };
        }
        let updated = await this.storage.updateRecordingPrograms(
            item,
            programs,
            new Date().toISOString()
        );
        if (!updated) {
            const current = await this.storage.getRecording(item.id);
            if (
                !current ||
                current.filePath !== filePath ||
                current.browserRemovalToken
            ) {
                return {
                    success: false,
                    error: BROWSER_MEDIA_MESSAGES.recordingNotFound,
                };
            }
            item = current;
            updated = await this.storage.updateRecordingPrograms(
                item,
                programs,
                new Date().toISOString()
            );
        }
        if (!updated) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.recordingNotFound,
            };
        }
        this.emitChange();
        return { success: true };
    }

    private onSettled(
        session: BrowserRecordingSession,
        result: ElectronBridgeErrorResult
    ): void {
        if (this.active === session) this.active = null;
        this.message = result.success
            ? BROWSER_MEDIA_MESSAGES.recordingSaved
            : BROWSER_MEDIA_MESSAGES.recordingSaveFailed;
        this.transitionKey = `${session.id}:${result.success ? 'completed' : 'failed'}`;
    }
}
