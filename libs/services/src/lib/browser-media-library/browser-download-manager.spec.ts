import type { DownloadItem, DownloadStartInput } from '../downloads.models';
import { sanitizeBrowserDownloadItem } from './browser-download-item';
import { BrowserDownloadManager } from './browser-download-manager';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import { captureBrowserDownloadSourceId } from './browser-download-source';
import { transferBrowserDownload } from './browser-download-transfer';
import type { BrowserPrivateStorage } from './browser-private-storage';

jest.mock('./browser-download-transfer', () => ({
    transferBrowserDownload: jest.fn(),
}));
jest.mock('./browser-download-source', () => ({
    ...jest.requireActual('./browser-download-source'),
    captureBrowserDownloadSourceId: jest.fn(),
}));

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

function input(id: number): DownloadStartInput {
    return {
        playlistId: 'playlist',
        xtreamId: id,
        contentType: 'vod',
        title: `Movie ${id}`,
        url: `/api/media/movie/${id}.mp4`,
    };
}

function testStorage(initial: DownloadItem[] = []) {
    const items = new Map<number, DownloadItem>(
        initial.map((item) => [item.id, item])
    );
    return {
        deleteDownload: jest.fn(async (id: number) => void items.delete(id)),
        deleteFile: jest.fn().mockResolvedValue(undefined),
        getDownload: jest.fn(async (id: number) => items.get(id)),
        listDownloads: jest.fn(async () => [...items.values()]),
        sanitizeDownload: jest.fn(async (id: number) => {
            const current = items.get(id);
            if (!current) return undefined;
            const sanitized = sanitizeBrowserDownloadItem(current);
            items.set(id, sanitized);
            return sanitized;
        }),
        putDownload: jest.fn(async (item: DownloadItem) => {
            items.set(item.id, item);
        }),
        putDownloadIfAbsent: jest.fn(async (item: DownloadItem) => {
            const existing = [...items.values()].find(
                (entry) =>
                    entry.playlistId === item.playlistId &&
                    entry.xtreamId === item.xtreamId &&
                    entry.contentType === item.contentType
            );
            if (existing) return existing;
            items.set(item.id, item);
            return item;
        }),
        claimDownloadForResume: jest.fn(
            async (
                id: number,
                ownerId: string,
                leaseUntil: number,
                updatedAt: string,
                capturedSourceId?: string
            ) => {
                const stored = items.get(id);
                const current = stored
                    ? sanitizeBrowserDownloadItem(stored)
                    : undefined;
                if (current) items.set(id, current);
                if (
                    !current ||
                    !current.url ||
                    !['paused', 'failed', 'canceled'].includes(current.status)
                ) {
                    return null;
                }
                const offset =
                    current.status === 'canceled'
                        ? 0
                        : (current.bytesDownloaded ?? 0);
                const previous = { ...current };
                const mediaSourceId =
                    current.mediaSourceId ??
                    (offset === 0 ? capturedSourceId : undefined);
                const item: DownloadItem = {
                    ...current,
                    status: 'queued',
                    browserOwnerId: ownerId,
                    browserLeaseUntil: leaseUntil,
                    errorMessage: undefined,
                    bytesDownloaded: offset,
                    ...(mediaSourceId ? { mediaSourceId } : {}),
                    updatedAt,
                };
                items.set(id, item);
                return { item, offset, previous };
            }
        ),
        claimDownloadForRedownload: jest.fn(
            async (
                id: number,
                ownerId: string,
                leaseUntil: number,
                updatedAt: string,
                capturedSourceId?: string
            ) => {
                const stored = items.get(id);
                const current = stored
                    ? sanitizeBrowserDownloadItem(stored)
                    : undefined;
                if (current) items.set(id, current);
                if (
                    !current ||
                    !current.url ||
                    current.status !== 'completed' ||
                    current.fileAvailability !== 'missing'
                ) {
                    return null;
                }
                const previous = { ...current };
                const mediaSourceId = current.mediaSourceId ?? capturedSourceId;
                const item: DownloadItem = {
                    ...current,
                    status: 'queued',
                    bytesDownloaded: 0,
                    totalBytes: undefined,
                    resumeValidator: undefined,
                    ...(mediaSourceId ? { mediaSourceId } : {}),
                    errorMessage: undefined,
                    browserOwnerId: ownerId,
                    browserLeaseUntil: leaseUntil,
                    updatedAt,
                };
                items.set(id, item);
                return { item, previous };
            }
        ),
        restoreDownloadClaim: jest.fn(
            async (id: number, ownerId: string, previous: DownloadItem) => {
                const current = items.get(id);
                if (
                    current?.status !== 'queued' ||
                    current.browserOwnerId !== ownerId
                ) {
                    return false;
                }
                items.set(id, previous);
                return true;
            }
        ),
        pauseOwnedDownloadClaim: jest.fn(
            async (id: number, ownerId: string, errorMessage: string) => {
                const current = items.get(id);
                if (
                    current?.status !== 'queued' ||
                    current.browserOwnerId !== ownerId
                ) {
                    return false;
                }
                items.set(id, {
                    ...current,
                    status: 'paused',
                    browserOwnerId: undefined,
                    browserLeaseUntil: undefined,
                    errorMessage,
                });
                return true;
            }
        ),
        refreshDownloadLease: jest.fn(
            async (id: number, ownerId: string, leaseUntil: number) => {
                const item = items.get(id);
                if (!item || item.browserOwnerId !== ownerId) return false;
                item.browserLeaseUntil = leaseUntil;
                return true;
            }
        ),
        recoverExpiredDownload: jest.fn(
            async (
                id: number,
                expectedOwnerId: string | undefined,
                expectedLeaseUntil: number | undefined,
                expiredAt: number,
                errorMessage: string,
                updatedAt: string
            ) => {
                const current = items.get(id);
                if (
                    !current ||
                    !['queued', 'downloading'].includes(current.status) ||
                    current.browserOwnerId !== expectedOwnerId ||
                    current.browserLeaseUntil !== expectedLeaseUntil ||
                    (current.browserLeaseUntil ?? 0) > expiredAt
                ) {
                    return false;
                }
                items.set(id, {
                    ...current,
                    status: 'paused',
                    browserOwnerId: undefined,
                    browserLeaseUntil: undefined,
                    errorMessage,
                    updatedAt,
                });
                return true;
            }
        ),
        updateDownloadMetadata: jest.fn(
            async (
                id: number,
                posterUrl: string | undefined,
                metadataSnapshot: DownloadItem['metadataSnapshot'],
                updatedAt: string
            ) => {
                const current = items.get(id);
                if (!current) return false;
                items.set(
                    id,
                    sanitizeBrowserDownloadItem({
                        ...current,
                        posterUrl,
                        metadataSnapshot,
                        updatedAt,
                    })
                );
                return true;
            }
        ),
        updateDownloadAvailability: jest.fn(
            async (
                expected: DownloadItem,
                fileAvailability: DownloadItem['fileAvailability'],
                updatedAt: string
            ) => {
                const current = items.get(expected.id);
                if (
                    !current ||
                    current.status !== expected.status ||
                    current.filePath !== expected.filePath ||
                    current.updatedAt !== expected.updatedAt ||
                    current.fileAvailability !== expected.fileAvailability
                ) {
                    return false;
                }
                items.set(expected.id, {
                    ...current,
                    fileAvailability,
                    updatedAt,
                });
                return true;
            }
        ),
    } as unknown as BrowserPrivateStorage;
}

describe('BrowserDownloadManager queue', () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

    beforeEach(() => {
        jest.restoreAllMocks();
        jest.mocked(captureBrowserDownloadSourceId).mockReset();
        jest.mocked(captureBrowserDownloadSourceId).mockResolvedValue(
            'source-a'
        );
        jest.mocked(transferBrowserDownload).mockReset();
        jest.spyOn(Date, 'now').mockReturnValue(1000);
        jest.spyOn(Math, 'random')
            .mockReturnValueOnce(0.001)
            .mockReturnValueOnce(0.002)
            .mockReturnValueOnce(0.003);
    });

    afterEach(() => {
        if (originalLocks) {
            Object.defineProperty(navigator, 'locks', originalLocks);
        } else {
            Reflect.deleteProperty(navigator, 'locks');
        }
    });

    it('starts no more than two transfers and preserves FIFO order', async () => {
        const first = deferred();
        const second = deferred();
        const third = deferred();
        const transfer = jest.mocked(transferBrowserDownload);
        transfer
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise)
            .mockReturnValueOnce(third.promise);
        const manager = new BrowserDownloadManager(
            testStorage(),
            () => true,
            jest.fn()
        );

        await manager.start(input(1));
        await manager.start(input(2));
        await manager.start(input(3));

        expect(transfer).toHaveBeenCalledTimes(2);
        expect(transfer.mock.calls.map(([, item]) => item.xtreamId)).toEqual([
            1, 2,
        ]);

        first.resolve();
        await first.promise;
        await Promise.resolve();
        await Promise.resolve();

        expect(transfer).toHaveBeenCalledTimes(3);
        expect(transfer.mock.calls[2]?.[1].xtreamId).toBe(3);
        second.resolve();
        third.resolve();
        await Promise.all([second.promise, third.promise]);
        await Promise.resolve();
        await Promise.resolve();
    });

    it('persists the enqueue source while a transfer waits in the queue', async () => {
        const first = deferred();
        const second = deferred();
        const third = deferred();
        const transfer = jest.mocked(transferBrowserDownload);
        transfer
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise)
            .mockReturnValueOnce(third.promise);
        const storage = testStorage();
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        await manager.start(input(21));
        await manager.start(input(22));
        const queued = await manager.start(input(23));

        expect(await storage.getDownload(queued.id as number)).toMatchObject({
            mediaSourceId: 'source-a',
            status: 'queued',
        });
        jest.mocked(captureBrowserDownloadSourceId).mockResolvedValue(
            'source-b'
        );

        first.resolve();
        await first.promise;
        await Promise.resolve();
        await Promise.resolve();

        expect(transfer.mock.calls[2]?.[1]).toMatchObject({
            mediaSourceId: 'source-a',
            xtreamId: 23,
        });
        second.resolve();
        third.resolve();
        await Promise.all([second.promise, third.promise]);
        await Promise.resolve();
    });

    it('does not recover or replace a download owned by a live tab', async () => {
        const existing: DownloadItem = {
            id: 77,
            playlistId: 'playlist',
            xtreamId: 7,
            contentType: 'vod',
            title: 'Movie 7',
            url: '/api/media/movie/7.mp4',
            filePath: 'opfs://zenplay-private-media/downloads/77.mp4',
            status: 'downloading',
            browserOwnerId: 'another-tab',
            browserLeaseUntil: Date.now() + 30_000,
        };
        const storage = testStorage([existing]);
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        await manager.recoverInterrupted();
        await expect(manager.start(input(7))).resolves.toEqual({
            success: true,
            id: 77,
        });

        expect(await storage.getDownload(77)).toMatchObject({
            status: 'downloading',
            browserOwnerId: 'another-tab',
        });
        expect(transferBrowserDownload).not.toHaveBeenCalled();
        expect(storage.deleteFile).not.toHaveBeenCalled();
    });

    it('keeps a live-tab queued item queued during recovery elsewhere', async () => {
        const queued: DownloadItem = {
            id: 78,
            playlistId: 'playlist',
            xtreamId: 8,
            contentType: 'vod',
            title: 'Movie 8',
            url: '/api/media/movie/8.mp4',
            filePath: 'opfs://zenplay-private-media/downloads/78.mp4',
            status: 'queued',
            browserOwnerId: 'another-tab',
            browserLeaseUntil: Date.now() + 30_000,
        };
        const storage = testStorage([queued]);
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        await manager.recoverInterrupted();

        expect(await storage.getDownload(78)).toMatchObject({
            status: 'queued',
            browserOwnerId: 'another-tab',
        });
    });

    it('recovers a crashed tab on list and lets an already-open tab retry it', async () => {
        const running = deferred();
        jest.mocked(transferBrowserDownload).mockReturnValue(running.promise);
        const expired: DownloadItem = {
            id: 84,
            playlistId: 'playlist',
            xtreamId: 14,
            contentType: 'vod',
            title: 'Movie 14',
            url: '/api/media/movie/14.mp4',
            filePath: 'opfs://zenplay-private-media/downloads/84.mp4',
            status: 'downloading',
            bytesDownloaded: 25,
            browserOwnerId: 'crashed-tab',
            browserLeaseUntil: Date.now() - 1,
        };
        const storage = testStorage([expired]);
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn(),
            {
                activate: jest.fn(),
                release: jest.fn(),
                ownerObservable: jest.fn().mockResolvedValue(false),
            }
        );

        const [recovered] = await manager.list();
        expect(recovered).toMatchObject({
            status: 'paused',
            bytesDownloaded: 25,
            errorMessage: BROWSER_MEDIA_MESSAGES.downloadRecoveredPaused,
        });
        expect(recovered).not.toHaveProperty('browserOwnerId');
        expect(recovered).not.toHaveProperty('browserLeaseUntil');

        await expect(manager.resume(expired.id)).resolves.toEqual({
            success: true,
        });
        expect(transferBrowserDownload).toHaveBeenCalledTimes(1);
        running.resolve();
        await running.promise;
        await Promise.resolve();
    });

    it('does not recover an expired lease while its owner is observable', async () => {
        const expired: DownloadItem = {
            id: 85,
            playlistId: 'playlist',
            xtreamId: 15,
            contentType: 'vod',
            title: 'Movie 15',
            url: '/api/media/movie/15.mp4',
            filePath: 'opfs://zenplay-private-media/downloads/85.mp4',
            status: 'queued',
            browserOwnerId: 'throttled-tab',
            browserLeaseUntil: Date.now() - 1,
        };
        const storage = testStorage([expired]);
        const ownerObservable = jest.fn().mockResolvedValue(true);
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn(),
            {
                activate: jest.fn(),
                release: jest.fn(),
                ownerObservable,
            }
        );

        const [stillActive] = await manager.list();

        expect(stillActive).toMatchObject({
            status: 'queued',
            browserOwnerId: 'throttled-tab',
        });
        expect(ownerObservable).toHaveBeenCalledWith(
            'throttled-tab',
            expired.id,
            Date.now()
        );
        expect(storage.recoverExpiredDownload).not.toHaveBeenCalled();
    });

    it('does not pause an owner that renews before the atomic recovery write', async () => {
        const expired: DownloadItem = {
            id: 86,
            playlistId: 'playlist',
            xtreamId: 16,
            contentType: 'vod',
            title: 'Movie 16',
            url: '/api/media/movie/16.mp4',
            filePath: 'opfs://zenplay-private-media/downloads/86.mp4',
            status: 'downloading',
            browserOwnerId: 'slow-tab',
            browserLeaseUntil: Date.now() - 1,
        };
        const storage = testStorage([expired]);
        jest.spyOn(storage, 'recoverExpiredDownload').mockImplementationOnce(
            async () => {
                await storage.refreshDownloadLease(
                    expired.id,
                    'slow-tab',
                    Date.now() + 60_000
                );
                return false;
            }
        );
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn(),
            {
                activate: jest.fn(),
                release: jest.fn(),
                ownerObservable: jest.fn().mockResolvedValue(false),
            }
        );

        const [stillActive] = await manager.list();

        expect(stillActive).toMatchObject({
            status: 'downloading',
            browserOwnerId: 'slow-tab',
            browserLeaseUntil: Date.now() + 60_000,
        });
    });

    it('atomically deduplicates simultaneous starts from two managers', async () => {
        const running = deferred();
        jest.mocked(transferBrowserDownload).mockReturnValue(running.promise);
        const storage = testStorage();
        const firstManager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );
        const secondManager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        const [first, second] = await Promise.all([
            firstManager.start(input(11)),
            secondManager.start(input(11)),
        ]);

        expect(first.id).toBe(second.id);
        expect(transferBrowserDownload).toHaveBeenCalledTimes(1);
        running.resolve();
        await running.promise;
        await Promise.resolve();
    });

    it('persists only allowlisted fields in the browser IndexedDB item', async () => {
        const storage = testStorage();
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );
        const unsafeInput = {
            ...input(12),
            url: 'https://stream-user:stream-pass@provider.example/movie/stream-user/stream-pass/12.mp4',
            headers: { userAgent: 'secret-agent', referer: 'secret-referer' },
            serverUrl: 'https://alice:secret@provider.example',
            portalUrl: 'https://portal.example/secret-token',
            macAddress: '00:11:22:33:44:55',
            username: 'alice',
            password: 'secret-password',
            posterUrl:
                'https://images.provider.example/poster.jpg?token=poster-secret',
            metadataSnapshot: {
                version: 1,
                language: 'es',
                mediaKind: 'movie',
                title: 'Movie 12',
                plot: 'Safe plot',
                posterUrl:
                    'https://images.provider.example/poster.jpg?token=nested-secret',
                backdropUrl: `${location.origin}/assets/backdrop.jpg`,
                cast: [
                    {
                        name: 'Actor',
                        profileUrl:
                            'https://images.provider.example/actor.jpg?token=cast-secret',
                    },
                ],
                unexpected: 'secret-unknown-field',
            },
        } as DownloadStartInput & Record<string, unknown>;

        const result = await manager.start(unsafeInput);
        const stored = await storage.getDownload(result.id as number);

        expect(stored).toMatchObject({
            playlistId: 'playlist',
            xtreamId: 12,
            title: 'Movie 12',
            url: '/api/media/movie/12.mp4',
            mediaSourceId: 'source-a',
        });
        for (const blocked of [
            'headers',
            'serverUrl',
            'portalUrl',
            'macAddress',
            'username',
            'password',
        ]) {
            expect(stored).not.toHaveProperty(blocked);
        }
        expect(JSON.stringify(stored)).not.toContain('secret');
        expect(JSON.stringify(stored)).not.toContain('stream-pass');
        expect(stored?.posterUrl).toBeUndefined();
        expect(stored?.metadataSnapshot).toEqual({
            version: 1,
            language: 'es',
            mediaKind: 'movie',
            title: 'Movie 12',
            plot: 'Safe plot',
            backdropUrl: '/assets/backdrop.jpg',
            cast: [{ name: 'Actor' }],
        });
    });

    it('rebuilds a legacy row without provider secrets or unknown fields', async () => {
        const legacy = {
            id: 76,
            playlistId: 'playlist',
            xtreamId: 6,
            contentType: 'vod',
            title: 'Legacy movie',
            url: 'https://alice:secret@provider.example/movie/alice/secret/6.mp4?token=legacy-secret',
            headers: {
                referer: 'https://provider.example/watch?token=secret',
                userAgent: 'secret-agent',
            },
            serverUrl: 'https://alice:secret@provider.example',
            portalUrl: 'https://portal.example?token=secret',
            macAddress: '00:11:22:33:44:55',
            username: 'alice',
            password: 'secret-password',
            mediaSourceId: 'source-a',
            posterUrl: 'https://alice:secret@provider.example/poster.jpg',
            metadataSnapshot: {
                version: 1,
                language: 'es',
                mediaKind: 'movie',
                title: 'Legacy movie',
                posterUrl:
                    'https://provider.example/poster.jpg?token=legacy-secret',
            },
            status: 'failed',
        } as DownloadItem & Record<string, unknown>;
        const storage = testStorage([legacy]);
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        const [listed] = await manager.list();

        expect(listed.url).toBe('/api/media/movie/6.mp4');
        expect(listed.posterUrl).toBeUndefined();
        expect(listed.metadataSnapshot).toEqual({
            version: 1,
            language: 'es',
            mediaKind: 'movie',
            title: 'Legacy movie',
        });
        const persisted = await storage.getDownload(76);
        for (const blocked of [
            'headers',
            'serverUrl',
            'portalUrl',
            'macAddress',
            'username',
            'password',
        ]) {
            expect(persisted).not.toHaveProperty(blocked);
        }
        expect(JSON.stringify(persisted)).not.toContain('secret');
        expect(JSON.stringify(persisted)).not.toContain('provider.example');
        expect(persisted?.mediaSourceId).toBe('source-a');
    });

    it('makes an unconvertible legacy source non-resumable without retaining it', async () => {
        const legacy = {
            id: 77,
            playlistId: 'playlist',
            xtreamId: 7,
            contentType: 'vod',
            title: 'Unsupported legacy file',
            url: 'https://alice:secret@provider.example/private/file.bin?token=legacy-secret',
            status: 'paused',
            bytesDownloaded: 25,
            browserOwnerId: 'other-tab',
            browserLeaseUntil: Date.now() + 60_000,
        } as DownloadItem;
        const storage = testStorage([legacy]);
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        const [listed] = await manager.list();

        expect(listed).toMatchObject({
            id: 77,
            url: '',
            status: 'failed',
            errorMessage: BROWSER_MEDIA_MESSAGES.sourceUnsupported,
        });
        expect(listed.browserOwnerId).toBeUndefined();
        expect(listed.browserLeaseUntil).toBeUndefined();
        expect(JSON.stringify(await storage.getDownload(77))).not.toContain(
            'secret'
        );
        await expect(manager.resume(77)).resolves.toEqual({
            success: false,
            error: BROWSER_MEDIA_MESSAGES.sourceUnsupported,
        });
    });

    it('atomically gives one tab ownership when both resume at once', async () => {
        const running = deferred();
        jest.mocked(transferBrowserDownload).mockReturnValue(running.promise);
        const paused: DownloadItem = {
            id: 79,
            playlistId: 'playlist',
            xtreamId: 9,
            contentType: 'vod',
            title: 'Movie 9',
            url: '/api/media/movie/9.mp4',
            filePath: 'opfs://zenplay-private-media/downloads/79.mp4',
            status: 'paused',
            bytesDownloaded: 25,
        };
        const storage = testStorage([paused]);
        const firstManager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );
        const secondManager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        const results = await Promise.all([
            firstManager.resume(79),
            secondManager.resume(79),
        ]);

        expect(results).toContainEqual({ success: true });
        expect(results).toContainEqual({
            success: false,
            error: BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab,
        });
        expect(transferBrowserDownload).toHaveBeenCalledTimes(1);
        expect(await storage.getDownload(79)).toMatchObject({
            status: 'queued',
            bytesDownloaded: 25,
        });
        running.resolve();
        await running.promise;
        await Promise.resolve();
    });

    it('rolls a resume claim back when another tab holds the Web Lock', async () => {
        Object.defineProperty(navigator, 'locks', {
            configurable: true,
            value: {
                request: jest.fn(
                    async (
                        _name: string,
                        _options: LockOptions,
                        callback: (lock: Lock | null) => Promise<void>
                    ) => callback(null)
                ),
            },
        });
        const paused: DownloadItem = {
            id: 80,
            playlistId: 'playlist',
            xtreamId: 10,
            contentType: 'vod',
            title: 'Movie 10',
            url: '/api/media/movie/10.mp4',
            filePath: 'opfs://zenplay-private-media/downloads/80.mp4',
            status: 'paused',
            bytesDownloaded: 25,
        };
        const storage = testStorage([paused]);
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        await expect(manager.resume(80)).resolves.toEqual({
            success: false,
            error: BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab,
        });
        expect(await storage.getDownload(80)).toEqual(paused);
        expect(transferBrowserDownload).not.toHaveBeenCalled();
    });

    it('atomically gives one tab a missing-file redownload', async () => {
        const running = deferred();
        jest.mocked(transferBrowserDownload).mockReturnValue(running.promise);
        const missing: DownloadItem = {
            id: 81,
            playlistId: 'playlist',
            xtreamId: 11,
            contentType: 'vod',
            title: 'Movie 11',
            url: '/api/media/movie/11.mp4',
            filePath: 'opfs://zenplay-private-media/downloads/81.mp4',
            fileAvailability: 'missing',
            status: 'completed',
            bytesDownloaded: 100,
            totalBytes: 100,
            mediaSourceId: 'source-a',
        };
        const storage = testStorage([missing]);
        const managers = [
            new BrowserDownloadManager(storage, () => true, jest.fn()),
            new BrowserDownloadManager(storage, () => true, jest.fn()),
        ];

        const results = await Promise.all(
            managers.map((manager) => manager.redownloadMissing(81))
        );

        expect(results).toContainEqual({ success: true });
        expect(results).toContainEqual({
            success: false,
            error: BROWSER_MEDIA_MESSAGES.downloadAlreadyActive,
        });
        expect(storage.deleteFile).toHaveBeenCalledTimes(1);
        expect(transferBrowserDownload).toHaveBeenCalledTimes(1);
        expect(
            jest.mocked(transferBrowserDownload).mock.calls[0]?.[1]
        ).toMatchObject({ mediaSourceId: 'source-a' });
        running.resolve();
        await running.promise;
        await Promise.resolve();
    });

    it('restores a missing-file row when another tab holds its Web Lock', async () => {
        Object.defineProperty(navigator, 'locks', {
            configurable: true,
            value: {
                request: jest.fn(
                    async (
                        _name: string,
                        _options: LockOptions,
                        callback: (lock: Lock | null) => Promise<void>
                    ) => callback(null)
                ),
            },
        });
        const missing: DownloadItem = {
            id: 83,
            playlistId: 'playlist',
            xtreamId: 13,
            contentType: 'vod',
            title: 'Movie 13',
            url: '/api/media/movie/13.mp4',
            filePath: 'opfs://zenplay-private-media/downloads/83.mp4',
            fileAvailability: 'missing',
            status: 'completed',
            bytesDownloaded: 100,
            totalBytes: 100,
            mediaSourceId: 'source-a',
        };
        const storage = testStorage([missing]);
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        await expect(manager.redownloadMissing(83)).resolves.toEqual({
            success: false,
            error: BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab,
        });
        expect(await storage.getDownload(83)).toEqual(missing);
        expect(storage.deleteFile).not.toHaveBeenCalled();
        expect(transferBrowserDownload).not.toHaveBeenCalled();
    });

    it('keeps the row when OPFS deletion fails so removal can be retried', async () => {
        const completed: DownloadItem = {
            id: 82,
            playlistId: 'playlist',
            xtreamId: 12,
            contentType: 'vod',
            title: 'Movie 12',
            url: '/api/media/movie/12.mp4',
            filePath: 'opfs://zenplay-private-media/downloads/82.mp4',
            fileAvailability: 'available',
            status: 'completed',
        };
        const storage = testStorage([completed]);
        jest.mocked(storage.deleteFile)
            .mockRejectedValueOnce(
                new DOMException('Denied', 'NotAllowedError')
            )
            .mockResolvedValueOnce(undefined);
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        await expect(manager.remove(82)).resolves.toMatchObject({
            success: false,
            error: 'Denied',
        });
        expect(await storage.getDownload(82)).toEqual(completed);
        await expect(manager.remove(82)).resolves.toEqual({ success: true });
        expect(await storage.getDownload(82)).toBeUndefined();
    });

    it('rejects HLS manifests instead of reporting a false offline download', async () => {
        const storage = testStorage();
        const manager = new BrowserDownloadManager(
            storage,
            () => true,
            jest.fn()
        );

        await expect(
            manager.start({ ...input(9), url: '/api/media/movie/9.m3u8' })
        ).resolves.toEqual({
            success: false,
            error: BROWSER_MEDIA_MESSAGES.hlsUnsupported,
        });
        expect(storage.putDownload).not.toHaveBeenCalled();
        expect(transferBrowserDownload).not.toHaveBeenCalled();
    });
});
