import type {
    ElectronBridgeErrorResult,
    RecordingStartMetadata,
} from '@iptvnator/shared/interfaces';
import type { RecordingItem } from '../recordings.models';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import { appendRecordingChunk } from './browser-recording-file';
import {
    browserRecordingError,
    nextBrowserRecordingId,
    selectBrowserRecordingMimeType,
} from './browser-recording-format';
import { BrowserRecordingLease } from './browser-recording-lease';
import { sanitizeBrowserRecordingItem } from './browser-recording-item';
import type { BrowserRecordingPresencePort } from './browser-recording-presence';
import {
    BrowserPrivateStorage,
    privateMediaPath,
} from './browser-private-storage';

const RECORDING_DIRECTORY = 'recordings';
const INITIAL_OWNER_LEASE_MS = 5 * 60_000;
const ERROR_STOP_FALLBACK_MS = 1_500;

interface CapturableVideo extends HTMLVideoElement {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
}

export interface BrowserRecordingSessionHooks {
    emitChange: () => void;
    settled: (
        session: BrowserRecordingSession,
        result: ElectronBridgeErrorResult
    ) => void;
}

export class BrowserRecordingSession {
    readonly startedAtMs = Date.now();
    readonly stopPromise: Promise<ElectronBridgeErrorResult>;

    private resolveStop!: (result: ElectronBridgeErrorResult) => void;
    private writeChain: Promise<void> = Promise.resolve();
    private writeError: string | null = null;
    private recorderError: string | null = null;
    private bytesWritten = 0;
    private lastPersistedAtMs = 0;
    private finishing = false;
    private stopFallback: ReturnType<typeof setTimeout> | null = null;
    private readonly endedListener = () => void this.stop();
    private readonly lease: BrowserRecordingLease;

    private constructor(
        private readonly storage: BrowserPrivateStorage,
        readonly id: number,
        readonly video: HTMLVideoElement,
        private readonly recorder: MediaRecorder,
        private readonly item: RecordingItem,
        private readonly ownerId: string,
        presence: BrowserRecordingPresencePort,
        private readonly hooks: BrowserRecordingSessionHooks
    ) {
        this.stopPromise = new Promise((resolve) => {
            this.resolveStop = resolve;
        });
        this.lease = new BrowserRecordingLease(
            storage,
            item,
            ownerId,
            presence,
            () => this.stopAfterOwnershipLoss()
        );
    }

    static async create(
        storage: BrowserPrivateStorage,
        video: HTMLVideoElement,
        metadata: RecordingStartMetadata | null,
        ownerId: string,
        presence: BrowserRecordingPresencePort,
        hooks: BrowserRecordingSessionHooks
    ): Promise<BrowserRecordingSession> {
        let stream: MediaStream | undefined;
        try {
            const capturable = video as CapturableVideo;
            stream =
                capturable.captureStream?.() ?? capturable.mozCaptureStream?.();
        } catch {
            throw new Error(BROWSER_MEDIA_MESSAGES.captureBlocked);
        }
        if (!stream || stream.getTracks().length === 0) {
            throw new Error(BROWSER_MEDIA_MESSAGES.noCapturableTracks);
        }

        const mimeType = selectBrowserRecordingMimeType();
        let recorder: MediaRecorder;
        try {
            recorder = new MediaRecorder(
                stream,
                mimeType ? { mimeType } : undefined
            );
        } catch (error) {
            throw new Error(
                browserRecordingError(
                    error,
                    BROWSER_MEDIA_MESSAGES.recordingStartFailed
                )
            );
        }
        const extension = (recorder.mimeType || mimeType)
            .toLowerCase()
            .includes('mp4')
            ? 'mp4'
            : 'webm';
        const id = nextBrowserRecordingId();
        const filePath = privateMediaPath(
            RECORDING_DIRECTORY,
            `${id}.${extension}`
        );
        try {
            await storage.getFileHandle(filePath, true);
        } catch (error) {
            throw new Error(
                browserRecordingError(
                    error,
                    BROWSER_MEDIA_MESSAGES.storagePreparationFailed
                )
            );
        }

        const startedAt = new Date().toISOString();
        const item = sanitizeBrowserRecordingItem({
            id,
            sessionId: `browser-${id}`,
            status: 'recording',
            filePath,
            fileSizeBytes: 0,
            fileAvailability: 'available',
            channelName:
                metadata?.channelName || BROWSER_MEDIA_MESSAGES.defaultLiveTv,
            channelLogoUrl: metadata?.channelLogoUrl,
            playlistId: metadata?.playlistId,
            playlistName: metadata?.playlistName,
            sourceType: metadata?.sourceType,
            epgChannelId: metadata?.epgChannelId,
            programTitle: metadata?.currentProgram?.title,
            programDescription: metadata?.currentProgram?.description,
            programStart: metadata?.currentProgram?.start,
            programStop: metadata?.currentProgram?.stop,
            programs: metadata?.currentProgram ? [metadata.currentProgram] : [],
            startedAt,
            createdAt: startedAt,
            updatedAt: startedAt,
            browserOwnerId: ownerId,
            browserLeaseUntil: Date.now() + INITIAL_OWNER_LEASE_MS,
            browserMimeType: recorder.mimeType || mimeType || undefined,
        });
        try {
            await storage.putRecording(item);
        } catch (error) {
            await storage.deleteFile(filePath);
            throw new Error(
                browserRecordingError(
                    error,
                    BROWSER_MEDIA_MESSAGES.recordingSaveFailed
                )
            );
        }
        return new BrowserRecordingSession(
            storage,
            id,
            video,
            recorder,
            item,
            ownerId,
            presence,
            hooks
        );
    }

    async start(): Promise<ElectronBridgeErrorResult> {
        this.video.addEventListener('ended', this.endedListener, {
            once: true,
        });
        this.video.addEventListener('emptied', this.endedListener, {
            once: true,
        });
        this.bindRecorder();
        try {
            this.recorder.start(2000);
        } catch (error) {
            this.removeVideoListeners();
            await this.storage.deleteRecording(this.id);
            await this.storage.deleteFile(this.item.filePath);
            const result = {
                success: false,
                error: browserRecordingError(
                    error,
                    BROWSER_MEDIA_MESSAGES.recordingStartFailed
                ),
            };
            this.resolveStop(result);
            return result;
        }
        this.lease.start();
        this.hooks.emitChange();
        return { success: true };
    }

    async stop(): Promise<ElectronBridgeErrorResult> {
        if (this.recorder.state !== 'inactive') this.recorder.stop();
        return this.stopPromise;
    }

    private bindRecorder(): void {
        this.recorder.addEventListener('dataavailable', (event) => {
            this.armErrorStopFallback();
            if (!event.data.size) return;
            this.writeChain = this.writeChain
                .then(async () => {
                    this.bytesWritten = await appendRecordingChunk(
                        this.storage,
                        this.item.filePath,
                        event.data,
                        this.bytesWritten
                    );
                    const now = Date.now();
                    if (now - this.lastPersistedAtMs < 5_000) return;
                    this.lastPersistedAtMs = now;
                    this.item.fileSizeBytes = this.bytesWritten;
                    this.item.updatedAt = new Date(now).toISOString();
                    this.lease.touch(now);
                    let persisted: boolean;
                    try {
                        persisted = await this.storage.putRecordingIfOwned(
                            this.item,
                            this.ownerId
                        );
                    } catch {
                        // The final write retries metadata persistence.
                        return;
                    }
                    if (!persisted) {
                        throw new Error(
                            BROWSER_MEDIA_MESSAGES.recordingOwnershipChanged
                        );
                    }
                    this.hooks.emitChange();
                })
                .catch((error) => {
                    this.writeError =
                        error instanceof Error ? error.message : String(error);
                    if (this.recorder.state !== 'inactive')
                        this.recorder.stop();
                });
        });
        this.recorder.addEventListener('error', (event) => {
            this.recorderError ??= browserRecordingError(
                (event as Event & { error?: unknown }).error,
                BROWSER_MEDIA_MESSAGES.recordingFailed
            );
            this.armErrorStopFallback();
            try {
                if (this.recorder.state !== 'inactive') this.recorder.stop();
            } catch {
                // The recorder error remains authoritative; the fallback settles.
            }
        });
        this.recorder.addEventListener('stop', () => {
            this.clearStopFallback();
            const failure = this.writeError ?? this.recorderError ?? undefined;
            void this.finish(failure ? 'failed' : 'completed', failure);
        });
    }

    private async finish(
        status: 'completed' | 'failed',
        failure?: string
    ): Promise<void> {
        if (this.finishing) return;
        this.finishing = true;
        this.clearStopFallback();
        this.lease.stop();
        this.removeVideoListeners();
        let result: ElectronBridgeErrorResult;
        try {
            await this.writeChain;
            if (this.writeError) throw new Error(this.writeError);
            if (this.bytesWritten === 0 && !failure) {
                throw new Error(BROWSER_MEDIA_MESSAGES.recordingEmpty);
            }
            result = { success: status === 'completed', error: failure };
        } catch (error) {
            status = 'failed';
            failure = error instanceof Error ? error.message : String(error);
            result = { success: false, error: failure };
        }

        this.item.status = status;
        this.item.fileSizeBytes = this.bytesWritten;
        this.item.errorMessage = failure;
        this.item.endedAt = new Date().toISOString();
        this.item.updatedAt = this.item.endedAt;
        this.item.fileAvailability =
            status === 'completed'
                ? 'available'
                : this.bytesWritten === 0
                  ? 'missing'
                  : 'unknown';
        this.item.browserOwnerId = undefined;
        this.item.browserLeaseUntil = undefined;
        try {
            if (this.bytesWritten === 0) {
                await this.storage.deleteFile(this.item.filePath);
            }
            const persisted = await this.storage.putRecordingIfOwned(
                this.item,
                this.ownerId
            );
            if (!persisted) {
                throw new Error(
                    BROWSER_MEDIA_MESSAGES.recordingOwnershipChanged
                );
            }
        } catch (error) {
            result = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
        this.resolveStop(result);
        this.hooks.settled(this, result);
        this.hooks.emitChange();
    }

    private armErrorStopFallback(): void {
        if (!this.recorderError || this.finishing) return;
        this.clearStopFallback();
        this.stopFallback = setTimeout(() => {
            this.stopFallback = null;
            const failure =
                this.writeError ??
                this.recorderError ??
                BROWSER_MEDIA_MESSAGES.recordingFailed;
            void this.finish('failed', failure);
        }, ERROR_STOP_FALLBACK_MS);
    }

    private clearStopFallback(): void {
        if (!this.stopFallback) return;
        clearTimeout(this.stopFallback);
        this.stopFallback = null;
    }

    private removeVideoListeners(): void {
        this.video.removeEventListener('ended', this.endedListener);
        this.video.removeEventListener('emptied', this.endedListener);
    }

    private stopAfterOwnershipLoss(): void {
        this.writeError = BROWSER_MEDIA_MESSAGES.recordingOwnershipChanged;
        if (this.recorder.state !== 'inactive') this.recorder.stop();
    }
}
