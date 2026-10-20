import type { RecordingStartMetadata } from '@iptvnator/shared/interfaces';
import type { RecordingItem } from '../recordings.models';
import { BrowserRecordingManager } from './browser-recording-manager';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import type { BrowserPrivateStorage } from './browser-private-storage';
import type { BrowserRecordingPresencePort } from './browser-recording-presence';

class TestMediaRecorder extends EventTarget {
    static instances: TestMediaRecorder[] = [];
    static isTypeSupported = () => true;

    readonly mimeType = 'video/webm';
    state: RecordingState = 'inactive';
    deferStopEvent = false;

    constructor() {
        super();
        TestMediaRecorder.instances.push(this);
    }

    start(): void {
        this.state = 'recording';
    }

    stop(): void {
        this.state = 'inactive';
        if (!this.deferStopEvent) this.emitStop();
    }

    emitData(data: Blob): void {
        const event = new Event('dataavailable');
        Object.defineProperty(event, 'data', { value: data });
        this.dispatchEvent(event);
    }

    emitError(error: Error): void {
        const event = new Event('error');
        Object.defineProperty(event, 'error', { value: error });
        this.dispatchEvent(event);
    }

    emitStop(): void {
        this.state = 'inactive';
        this.dispatchEvent(new Event('stop'));
    }
}

function recordingItem(overrides: Partial<RecordingItem> = {}): RecordingItem {
    return {
        id: 1,
        sessionId: 'browser-1',
        status: 'recording',
        channelName: 'Channel',
        filePath: 'opfs://zenplay-private-media/recordings/1.webm',
        fileSizeBytes: 0,
        fileAvailability: 'available',
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

function testStorage(
    initial: RecordingItem[] = [],
    files: ReadonlyMap<string, File> = new Map()
) {
    const items = new Map(
        initial.map((item) => [item.id, { ...item }] as const)
    );
    const sizes = new Map(
        [...files.entries()].map(([path, file]) => [path, file.size] as const)
    );
    const writers: Array<{
        abort: jest.Mock;
        close: jest.Mock;
        seek: jest.Mock;
        write: jest.Mock;
    }> = [];
    let nextWriteError: Error | null = null;
    const storage = {
        deleteFile: jest.fn(async (path?: string) => {
            if (path) sizes.delete(path);
        }),
        deleteRecording: jest.fn(async (id: number) => void items.delete(id)),
        getFileHandle: jest.fn(async (filePath: string, create: boolean) => {
            if (!sizes.has(filePath)) {
                if (!create)
                    throw new DOMException('Not found', 'NotFoundError');
                sizes.set(filePath, 0);
            }
            return {
                getFile: jest.fn(
                    async () =>
                        new File(
                            [new Uint8Array(sizes.get(filePath) ?? 0)],
                            'recording.webm'
                        )
                ),
                createWritable: jest.fn(
                    async (options?: { keepExistingData?: boolean }) => {
                        let stagedSize = options?.keepExistingData
                            ? (sizes.get(filePath) ?? 0)
                            : 0;
                        let cursor = 0;
                        const writer = {
                            abort: jest.fn().mockResolvedValue(undefined),
                            close: jest.fn(async () => {
                                sizes.set(filePath, stagedSize);
                            }),
                            seek: jest.fn(async (offset: number) => {
                                cursor = offset;
                            }),
                            write: jest.fn(async (data: Blob) => {
                                if (nextWriteError) {
                                    const error = nextWriteError;
                                    nextWriteError = null;
                                    throw error;
                                }
                                stagedSize = Math.max(
                                    stagedSize,
                                    cursor + data.size
                                );
                                cursor += data.size;
                            }),
                        };
                        writers.push(writer);
                        return writer;
                    }
                ),
            };
        }),
        getFile: jest.fn(async (filePath: string) =>
            sizes.has(filePath)
                ? new File(
                      [new Uint8Array(sizes.get(filePath) ?? 0)],
                      'recording.webm'
                  )
                : null
        ),
        getRecording: jest.fn(async (id: number) => {
            const item = items.get(id);
            return item ? { ...item } : undefined;
        }),
        listRecordings: jest.fn(async () =>
            [...items.values()].map((item) => ({ ...item }))
        ),
        putRecording: jest.fn(async (item: RecordingItem) => {
            items.set(item.id, { ...item });
        }),
        putRecordingIfOwned: jest.fn(
            async (item: RecordingItem, ownerId: string) => {
                const current = items.get(item.id);
                if (
                    current?.status !== 'recording' ||
                    current.browserOwnerId !== ownerId
                ) {
                    return false;
                }
                items.set(item.id, { ...item });
                return true;
            }
        ),
        refreshRecordingLease: jest.fn().mockResolvedValue(true),
        updateRecordingAvailability: jest.fn(
            async (
                expected: RecordingItem,
                availability: RecordingItem['fileAvailability'],
                updatedAt: string
            ) => {
                const current = items.get(expected.id);
                if (
                    !current ||
                    current.updatedAt !== expected.updatedAt ||
                    current.filePath !== expected.filePath ||
                    current.status !== expected.status
                ) {
                    return false;
                }
                items.set(expected.id, {
                    ...current,
                    fileAvailability: availability,
                    updatedAt,
                });
                return true;
            }
        ),
        updateRecordingPrograms: jest.fn(
            async (
                expected: RecordingItem,
                programs: RecordingItem['programs'],
                updatedAt: string
            ) => {
                const current = items.get(expected.id);
                if (
                    !current ||
                    current.filePath !== expected.filePath ||
                    current.updatedAt !== expected.updatedAt ||
                    current.browserRemovalToken ||
                    current.browserRemovalToken !== expected.browserRemovalToken
                ) {
                    return false;
                }
                const versionMs = Math.max(
                    Date.parse(current.updatedAt ?? '') + 1,
                    Date.parse(updatedAt)
                );
                items.set(expected.id, {
                    ...current,
                    programs,
                    updatedAt: new Date(versionMs).toISOString(),
                });
                return true;
            }
        ),
        claimRecordingRemoval: jest.fn(
            async (
                id: number,
                token: string,
                requesterOwnerId: string,
                now: number
            ) => {
                const current = items.get(id);
                if (!current) return { outcome: 'missing' as const };
                if (
                    current.browserRemovalToken ||
                    (current.status === 'recording' &&
                        current.browserOwnerId !== requesterOwnerId &&
                        (current.browserLeaseUntil ?? 0) > now)
                ) {
                    return { outcome: 'active-other-tab' as const };
                }
                const claimed = { ...current, browserRemovalToken: token };
                items.set(id, claimed);
                return { outcome: 'claimed' as const, item: claimed };
            }
        ),
        completeRecordingRemoval: jest.fn(async (id: number, token: string) => {
            if (items.get(id)?.browserRemovalToken !== token) return false;
            items.delete(id);
            return true;
        }),
        releaseRecordingRemoval: jest.fn(async (id: number, token: string) => {
            const current = items.get(id);
            if (current?.browserRemovalToken !== token) return false;
            const released = { ...current };
            delete released.browserRemovalToken;
            delete released.browserRemovalStartedAt;
            items.set(id, released);
            return true;
        }),
        recoverExpiredRecording: jest.fn(
            async (
                item: RecordingItem,
                expectedOwnerId: string | undefined,
                expiredAt: number
            ) => {
                const current = items.get(item.id);
                if (
                    current?.status !== 'recording' ||
                    current.browserOwnerId !== expectedOwnerId ||
                    (current.browserLeaseUntil ?? 0) > expiredAt
                ) {
                    return false;
                }
                items.set(item.id, { ...item });
                return true;
            }
        ),
    } as unknown as BrowserPrivateStorage;
    return {
        storage,
        writers,
        failNextWrite: (error: Error) => {
            nextWriteError = error;
        },
    };
}

function presence(observable = false): BrowserRecordingPresencePort {
    return {
        activate: jest.fn(),
        release: jest.fn(),
        ownerObservable: jest.fn().mockResolvedValue(observable),
    };
}

function capturableVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    Object.defineProperty(video, 'captureStream', {
        configurable: true,
        value: () => ({ getTracks: () => [{}] }),
    });
    return video;
}

describe('BrowserRecordingManager', () => {
    const originalMediaRecorder = Object.getOwnPropertyDescriptor(
        globalThis,
        'MediaRecorder'
    );

    beforeEach(() => {
        TestMediaRecorder.instances = [];
        Object.defineProperty(globalThis, 'MediaRecorder', {
            configurable: true,
            value: TestMediaRecorder,
        });
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        if (originalMediaRecorder) {
            Object.defineProperty(
                globalThis,
                'MediaRecorder',
                originalMediaRecorder
            );
        } else {
            delete (globalThis as { MediaRecorder?: typeof MediaRecorder })
                .MediaRecorder;
        }
    });

    it('fails and removes an empty recording instead of marking it complete', async () => {
        const { storage, writers } = testStorage();
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence()
        );

        await expect(manager.toggle(capturableVideo(), null)).resolves.toEqual({
            success: true,
        });
        const result = await manager.toggle(
            manager.snapshot().owner as HTMLVideoElement,
            null
        );
        const [item] = await storage.listRecordings();

        expect(result).toMatchObject({ success: false });
        expect(result.error).toBe(BROWSER_MEDIA_MESSAGES.recordingEmpty);
        expect(item).toMatchObject({
            status: 'failed',
            fileAvailability: 'missing',
        });
        expect(storage.deleteFile).toHaveBeenCalledWith(item?.filePath);
        expect(writers).toHaveLength(0);
    });

    it('writes ordered chunks and completes a non-empty recording', async () => {
        const { storage, writers } = testStorage();
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence()
        );
        const video = capturableVideo();

        await manager.toggle(video, null);
        const recorder = TestMediaRecorder.instances.at(-1);
        recorder?.emitData(new Blob(['one']));
        recorder?.emitData(new Blob(['two']));
        const result = await manager.toggle(video, null);
        const [item] = await storage.listRecordings();

        expect(result).toEqual({ success: true, error: undefined });
        expect(writers).toHaveLength(2);
        expect(
            writers.every((writer) => writer.close.mock.calls.length === 1)
        ).toBe(true);
        expect(item).toMatchObject({
            status: 'completed',
            fileSizeBytes: 6,
            browserMimeType: 'video/webm',
        });
    });

    it('sanitizes metadata before the first recording write', async () => {
        const { storage } = testStorage();
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence()
        );
        const metadata = {
            channelName: 'Channel',
            channelLogoUrl:
                'https://alice:secret@provider.example/logo.png?token=secret',
            playlistId: 'playlist-1',
            playlistName: 'https://provider.example/list?token=secret',
            sourceType: 'xtream',
            epgChannelId: 'Guide España 1',
            currentProgram: {
                title: 'Programme',
                description: 'See https://provider.example/epg?token=secret',
                start: '2026-10-20T12:00:00.000Z',
                stop: '2026-10-20T13:00:00.000Z',
            },
            serverUrl: 'https://provider.example',
            requestHeaders: { Authorization: 'Bearer secret' },
        } as RecordingStartMetadata;

        await manager.toggle(capturableVideo(), metadata);

        const [persisted] = await storage.listRecordings();
        expect(persisted).toMatchObject({
            channelName: 'Channel',
            playlistId: 'playlist-1',
            epgChannelId: 'Guide España 1',
            programTitle: 'Programme',
        });
        expect(persisted).not.toHaveProperty('channelLogoUrl');
        expect(persisted).not.toHaveProperty('playlistName');
        expect(persisted).not.toHaveProperty('programDescription');
        expect(persisted).not.toHaveProperty('serverUrl');
        expect(persisted).not.toHaveProperty('requestHeaders');
        expect(persisted.programs?.[0]).not.toHaveProperty('description');
        await manager.stop(persisted.id);
    });

    it('reports a private-storage write failure without completing', async () => {
        const { storage, writers, failNextWrite } = testStorage();
        failNextWrite(new Error('Quota exceeded'));
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence()
        );
        const video = capturableVideo();

        await manager.toggle(video, null);
        TestMediaRecorder.instances.at(-1)?.emitData(new Blob(['data']));
        const result = await manager.toggle(video, null);
        const [item] = await storage.listRecordings();

        expect(result).toMatchObject({
            success: false,
            error: 'Quota exceeded',
        });
        expect(item).toMatchObject({ status: 'failed' });
        expect(writers[0]?.abort).toHaveBeenCalled();
    });

    it('waits for the final chunk and stop event after a recorder error', async () => {
        const { storage } = testStorage();
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence()
        );
        const video = capturableVideo();

        await manager.toggle(video, null);
        const [active] = await storage.listRecordings();
        const recorder = TestMediaRecorder.instances.at(-1);
        if (!recorder) throw new Error('Missing test recorder');
        recorder.deferStopEvent = true;
        recorder.emitError(new Error('Encoder crashed'));
        const resultPromise = manager.stop(active.id);
        let settled = false;
        void resultPromise.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        recorder.emitData(new Blob(['final chunk']));
        recorder.emitStop();

        await expect(resultPromise).resolves.toEqual({
            success: false,
            error: 'Encoder crashed',
        });
        await expect(storage.getRecording(active.id)).resolves.toMatchObject({
            status: 'failed',
            fileSizeBytes: 11,
            fileAvailability: 'unknown',
            errorMessage: 'Encoder crashed',
        });
        expect(storage.deleteFile).not.toHaveBeenCalledWith(active.filePath);
    });

    it('preserves a final chunk when recorder stop never arrives', async () => {
        jest.useFakeTimers();
        const { storage } = testStorage();
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence()
        );
        const video = capturableVideo();

        await manager.toggle(video, null);
        const [active] = await storage.listRecordings();
        const recorder = TestMediaRecorder.instances.at(-1);
        if (!recorder) throw new Error('Missing test recorder');
        recorder.deferStopEvent = true;
        recorder.emitError(new Error('Encoder stopped unexpectedly'));
        const resultPromise = manager.stop(active.id);
        recorder.emitData(new Blob(['tail']));
        await jest.advanceTimersByTimeAsync(2_000);

        await expect(resultPromise).resolves.toEqual({
            success: false,
            error: 'Encoder stopped unexpectedly',
        });
        await expect(storage.getRecording(active.id)).resolves.toMatchObject({
            status: 'failed',
            fileSizeBytes: 4,
            fileAvailability: 'unknown',
            errorMessage: 'Encoder stopped unexpectedly',
        });
    });

    it('does not recover or remove a live recording owned by another tab', async () => {
        const live = recordingItem({
            browserOwnerId: 'another-tab',
            browserLeaseUntil: Date.now() + 30_000,
        });
        const { storage } = testStorage([live]);
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn()
        );

        await manager.recoverInterrupted();
        await expect(manager.remove(live.id)).resolves.toEqual({
            success: false,
            error: BROWSER_MEDIA_MESSAGES.recordingActiveOtherTab,
        });
        expect(await storage.getRecording(live.id)).toMatchObject({
            status: 'recording',
            browserOwnerId: 'another-tab',
        });
        expect(await manager.list()).toEqual([
            expect.objectContaining({ browserOwnedByThisTab: false }),
        ]);
        expect(storage.deleteFile).not.toHaveBeenCalled();
    });

    it('recovers an expired non-empty recording using the actual private file size', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-20T12:00:00Z'));
        const expired = recordingItem({
            browserOwnerId: 'crashed-tab',
            browserLeaseUntil: Date.now() - 1,
        });
        const file = new File(['recorded bytes'], '1.webm', {
            type: 'video/webm',
        });
        const { storage } = testStorage(
            [expired],
            new Map([[expired.filePath, file]])
        );
        const emitChange = jest.fn();
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            emitChange
        );

        const [recovered] = await manager.list();

        expect(recovered).toMatchObject({
            status: 'interrupted',
            fileSizeBytes: file.size,
            fileAvailability: 'available',
            browserOwnerId: undefined,
            browserLeaseUntil: undefined,
            errorMessage: BROWSER_MEDIA_MESSAGES.recordingInterrupted,
        });
        expect(storage.deleteFile).not.toHaveBeenCalled();
        expect(emitChange).toHaveBeenCalledTimes(1);
    });

    it('fails and deletes an empty file left by a crashed recording tab', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-20T12:00:00Z'));
        const expired = recordingItem({
            browserOwnerId: 'crashed-tab',
            browserLeaseUntil: Date.now() - 1,
        });
        const empty = new File([], '1.webm', { type: 'video/webm' });
        const { storage } = testStorage(
            [expired],
            new Map([[expired.filePath, empty]])
        );
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn()
        );

        const [recovered] = await manager.list();

        expect(recovered).toMatchObject({
            status: 'failed',
            fileSizeBytes: 0,
            fileAvailability: 'missing',
            errorMessage: BROWSER_MEDIA_MESSAGES.recordingEmpty,
        });
        expect(storage.deleteFile).toHaveBeenCalledWith(expired.filePath);
    });

    it('does not overwrite a recording whose owner renewed during recovery', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-20T12:00:00Z'));
        const expired = recordingItem({
            browserOwnerId: 'slow-tab',
            browserLeaseUntil: Date.now() - 1,
        });
        const { storage } = testStorage([expired]);
        jest.spyOn(storage, 'recoverExpiredRecording').mockResolvedValue(false);
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn()
        );

        const [stillActive] = await manager.list();

        expect(stillActive).toMatchObject({
            status: 'recording',
            browserOwnerId: 'slow-tab',
        });
        expect(storage.deleteFile).not.toHaveBeenCalled();
    });

    it('does not recover an expired lease while its tab answers a liveness probe', async () => {
        const expired = recordingItem({
            browserOwnerId: 'throttled-mobile-tab',
            browserLeaseUntil: Date.now() - 1,
        });
        const { storage } = testStorage([expired]);
        const ownerPresence = presence(true);
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            ownerPresence
        );

        const [stillActive] = await manager.list();

        expect(stillActive).toMatchObject({
            status: 'recording',
            browserOwnerId: 'throttled-mobile-tab',
        });
        expect(ownerPresence.ownerObservable).toHaveBeenCalledWith(
            'throttled-mobile-tab',
            expired.id,
            expect.any(Number)
        );
        expect(storage.recoverExpiredRecording).not.toHaveBeenCalled();
    });

    it('extends ownership conservatively before a mobile tab is hidden', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-20T12:00:00Z'));
        const visibility = Object.getOwnPropertyDescriptor(
            document,
            'visibilityState'
        );
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
        });
        const { storage } = testStorage();
        const ownerPresence = presence();
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            ownerPresence
        );

        try {
            await manager.toggle(capturableVideo(), null);
            document.dispatchEvent(new Event('visibilitychange'));
            await Promise.resolve();

            const leaseUntil = jest
                .mocked(storage.refreshRecordingLease)
                .mock.calls.at(-1)?.[2];
            expect(leaseUntil).toBeGreaterThanOrEqual(Date.now() + 30 * 60_000);
            expect(ownerPresence.activate).toHaveBeenLastCalledWith(
                expect.any(String),
                expect.any(Number),
                leaseUntil
            );
            await manager.toggle(
                manager.snapshot().owner as HTMLVideoElement,
                null
            );
        } finally {
            if (visibility) {
                Object.defineProperty(document, 'visibilityState', visibility);
            } else {
                delete (
                    document as { visibilityState?: DocumentVisibilityState }
                ).visibilityState;
            }
        }
    });

    it('honors a lease renewal won atomically while remove is claiming the row', async () => {
        const expired = recordingItem({
            browserOwnerId: 'other-tab',
            browserLeaseUntil: Date.now() - 1,
        });
        const { storage } = testStorage([expired]);
        jest.spyOn(storage, 'claimRecordingRemoval').mockResolvedValue({
            outcome: 'active-other-tab',
        });
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence(false)
        );

        await expect(manager.remove(expired.id)).resolves.toEqual({
            success: false,
            error: BROWSER_MEDIA_MESSAGES.recordingActiveOtherTab,
        });
        expect(storage.deleteFile).not.toHaveBeenCalled();
        expect(storage.completeRecordingRemoval).not.toHaveBeenCalled();
    });

    it('releases its removal claim when OPFS refuses to delete the file', async () => {
        const completed = recordingItem({
            status: 'completed',
            browserOwnerId: undefined,
            browserLeaseUntil: undefined,
        });
        const { storage } = testStorage([completed]);
        jest.spyOn(storage, 'deleteFile').mockRejectedValue(
            new DOMException('Denied', 'NotAllowedError')
        );
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence()
        );

        await expect(manager.remove(completed.id)).resolves.toEqual({
            success: false,
            error: 'Denied',
        });
        const retained = await storage.getRecording(completed.id);
        expect(retained).toMatchObject({ id: completed.id });
        expect(retained).not.toHaveProperty('browserRemovalToken');
        expect(storage.releaseRecordingRemoval).toHaveBeenCalledWith(
            completed.id,
            expect.any(String)
        );
        expect(storage.completeRecordingRemoval).not.toHaveBeenCalled();
    });

    it('does not recreate a row deleted while file availability is checked', async () => {
        const completed = recordingItem({
            status: 'completed',
            browserOwnerId: undefined,
            browserLeaseUntil: undefined,
            fileAvailability: 'available',
        });
        const { storage } = testStorage([completed]);
        jest.spyOn(storage, 'updateRecordingAvailability').mockImplementation(
            async () => {
                await storage.deleteRecording(completed.id);
                return false;
            }
        );
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence()
        );

        await expect(manager.list()).resolves.toEqual([]);
        expect(storage.putRecording).not.toHaveBeenCalled();
    });

    it('does not recreate a recording deleted during a programme update', async () => {
        const completed = recordingItem({
            status: 'completed',
            browserOwnerId: undefined,
            browserLeaseUntil: undefined,
        });
        const file = new File(['recorded'], '1.webm');
        const { storage } = testStorage(
            [completed],
            new Map([[completed.filePath, file]])
        );
        jest.spyOn(storage, 'updateRecordingPrograms').mockImplementation(
            async () => {
                await storage.deleteRecording(completed.id);
                return false;
            }
        );
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence()
        );

        await expect(
            manager.updatePrograms(completed.filePath, [])
        ).resolves.toEqual({
            success: false,
            error: BROWSER_MEDIA_MESSAGES.recordingNotFound,
        });
        await expect(
            storage.getRecording(completed.id)
        ).resolves.toBeUndefined();
        expect(storage.putRecording).not.toHaveBeenCalled();
    });

    it('does not overwrite a recording claimed for removal during a programme update', async () => {
        const completed = recordingItem({
            status: 'completed',
            browserOwnerId: undefined,
            browserLeaseUntil: undefined,
            programs: [],
        });
        const file = new File(['recorded'], '1.webm');
        const { storage } = testStorage(
            [completed],
            new Map([[completed.filePath, file]])
        );
        jest.spyOn(storage, 'updateRecordingPrograms').mockImplementation(
            async () => {
                await storage.claimRecordingRemoval(
                    completed.id,
                    'remove-token',
                    'other-tab',
                    Date.now()
                );
                return false;
            }
        );
        const manager = new BrowserRecordingManager(
            storage,
            () => true,
            jest.fn(),
            presence()
        );

        await expect(
            manager.updatePrograms(completed.filePath, [
                {
                    title: 'Should not persist',
                    start: '2026-10-20T12:00:00.000Z',
                    stop: '2026-10-20T13:00:00.000Z',
                },
            ])
        ).resolves.toEqual({
            success: false,
            error: BROWSER_MEDIA_MESSAGES.recordingNotFound,
        });
        await expect(storage.getRecording(completed.id)).resolves.toMatchObject(
            {
                browserRemovalToken: 'remove-token',
                programs: [],
            }
        );
        expect(storage.putRecording).not.toHaveBeenCalled();
    });
});
