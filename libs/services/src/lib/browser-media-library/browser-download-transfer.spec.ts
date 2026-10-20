import type { DownloadItem } from '../downloads.models';
import { transferBrowserDownload } from './browser-download-transfer';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import type { BrowserPrivateStorage } from './browser-private-storage';

function downloadItem(): DownloadItem {
    return {
        id: 7,
        playlistId: 'source',
        xtreamId: 42,
        contentType: 'vod',
        title: 'Movie',
        url: '/api/media/movie/42.mp4',
        filePath: 'opfs://zenplay-private-media/downloads/7.mp4',
        fileAvailability: 'available',
        status: 'paused',
        bytesDownloaded: 128,
        resumeValidator: '"version-1"',
        mediaSourceId: 'source-a',
    };
}

function testStorage(partialSize: number) {
    let current: DownloadItem | undefined;
    const writer = {
        write: jest.fn().mockResolvedValue(undefined),
        seek: jest.fn().mockResolvedValue(undefined),
        truncate: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        abort: jest.fn().mockResolvedValue(undefined),
    };
    const createWritable = jest.fn().mockResolvedValue(writer);
    const storage = {
        getFile: jest
            .fn()
            .mockResolvedValue(new File([new Uint8Array(partialSize)], 'part')),
        getFileHandle: jest.fn().mockResolvedValue({ createWritable }),
        deleteFile: jest.fn().mockResolvedValue(undefined),
        putDownload: jest.fn(async (item: DownloadItem) => {
            current = { ...item };
        }),
        claimDownload: jest.fn(async (item: DownloadItem) => {
            current = { ...item };
            return true;
        }),
        putDownloadIfOwned: jest.fn(
            async (item: DownloadItem, ownerId: string) => {
                if (
                    current?.status !== 'downloading' ||
                    current.browserOwnerId !== ownerId
                ) {
                    return false;
                }
                current = { ...item };
                return true;
            }
        ),
        getDownload: jest.fn(async () =>
            current ? { ...current } : undefined
        ),
    } as unknown as BrowserPrivateStorage;
    return { createWritable, storage, writer };
}

function testResponse(
    bytes: number[],
    status: number,
    headers: Record<string, string>
): Response {
    let delivered = false;
    const body = {
        cancel: jest.fn().mockResolvedValue(undefined),
        getReader: () => ({
            read: jest.fn().mockImplementation(async () => {
                if (delivered) return { done: true, value: undefined };
                delivered = true;
                return { done: false, value: new Uint8Array(bytes) };
            }),
        }),
    };
    return {
        body,
        headers: new Headers(headers),
        ok: status >= 200 && status < 300,
        status,
    } as unknown as Response;
}

describe('transferBrowserDownload', () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

    afterEach(() => {
        jest.restoreAllMocks();
        if (originalFetch) {
            Object.defineProperty(globalThis, 'fetch', originalFetch);
        } else {
            delete (globalThis as { fetch?: typeof fetch }).fetch;
        }
    });

    function installFetch(...responses: Response[]) {
        const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
        for (const response of responses) {
            fetchMock.mockResolvedValueOnce(response);
        }
        Object.defineProperty(globalThis, 'fetch', {
            configurable: true,
            value: fetchMock,
        });
        return fetchMock;
    }

    it('asserts the captured source on the first transfer request', async () => {
        const { storage } = testStorage(0);
        const fetchMock = installFetch(
            testResponse([1], 200, {
                'Content-Length': '1',
                ETag: '"version-1"',
                'X-ZenPlay-Media-Source': 'source-a',
            })
        );
        const item = downloadItem();
        item.bytesDownloaded = 0;
        item.resumeValidator = undefined;

        await transferBrowserDownload(
            storage,
            item,
            0,
            new AbortController(),
            jest.fn()
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
            headers: {
                'x-zenplay-expected-media-source': 'source-a',
            },
        });
        expect(item.status).toBe('completed');
    });

    it('does not make an initial request without a persisted source', async () => {
        const { createWritable, storage } = testStorage(0);
        const fetchMock = installFetch();
        const item = downloadItem();
        item.bytesDownloaded = 0;
        item.mediaSourceId = undefined;

        await transferBrowserDownload(
            storage,
            item,
            0,
            new AbortController(),
            jest.fn()
        );

        expect(fetchMock).not.toHaveBeenCalled();
        expect(createWritable).not.toHaveBeenCalled();
        expect(item.status).toBe('failed');
        expect(item.errorMessage).toBe(
            BROWSER_MEDIA_MESSAGES.sourceUnconfirmed
        );
    });

    it('appends only when Content-Range starts at the saved file size', async () => {
        const { createWritable, storage, writer } = testStorage(128);
        const fetchMock = installFetch(
            testResponse([1, 2], 206, {
                'Content-Length': '2',
                'Content-Range': 'bytes 128-129/130',
                ETag: '"version-1"',
                'X-ZenPlay-Media-Source': 'source-a',
            })
        );

        const item = downloadItem();
        await transferBrowserDownload(
            storage,
            item,
            128,
            new AbortController(),
            jest.fn()
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
            headers: {
                Range: 'bytes=128-',
                'If-Range': '"version-1"',
            },
        });
        expect(createWritable).toHaveBeenCalledWith({ keepExistingData: true });
        expect(writer.seek).toHaveBeenCalledWith(128);
        expect(writer.truncate).toHaveBeenLastCalledWith(130);
        expect(item.status).toBe('completed');
    });

    it('restarts from zero when the validator changed between resumes', async () => {
        const { createWritable, storage, writer } = testStorage(128);
        const fetchMock = installFetch(
            testResponse([9], 206, {
                'Content-Range': 'bytes 128-128/130',
                ETag: '"version-2"',
                'X-ZenPlay-Media-Source': 'source-a',
            }),
            testResponse([1, 2], 200, {
                'Content-Length': '2',
                'X-ZenPlay-Media-Source': 'source-a',
            })
        );

        const item = downloadItem();
        await transferBrowserDownload(
            storage,
            item,
            128,
            new AbortController(),
            jest.fn()
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
            headers: {
                Range: 'bytes=128-',
                'If-Range': '"version-1"',
            },
        });
        expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
            headers: {
                'x-zenplay-expected-media-source': 'source-a',
            },
        });
        expect(createWritable).toHaveBeenCalledWith({
            keepExistingData: false,
        });
        expect(writer.seek).not.toHaveBeenCalled();
        expect(writer.truncate).toHaveBeenNthCalledWith(1, 0);
        expect(writer.truncate).toHaveBeenLastCalledWith(2);
        expect(item.status).toBe('completed');
    });

    it('does not overwrite a paused state after an in-flight write settles', async () => {
        const { storage, writer } = testStorage(0);
        let releaseWrite!: () => void;
        let markWriteStarted!: () => void;
        const writeStarted = new Promise<void>((resolve) => {
            markWriteStarted = resolve;
        });
        writer.write.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    releaseWrite = resolve;
                    markWriteStarted();
                })
        );
        installFetch(
            testResponse([1], 200, {
                'Content-Length': '1',
                ETag: '"version-1"',
                'X-ZenPlay-Media-Source': 'source-a',
            })
        );
        const controller = new AbortController();
        const item = downloadItem();
        item.bytesDownloaded = 0;

        const transfer = transferBrowserDownload(
            storage,
            item,
            0,
            controller,
            jest.fn()
        );
        await writeStarted;
        await storage.putDownload({ ...item, status: 'paused' });
        controller.abort();
        releaseWrite();
        await transfer;

        const statuses = jest
            .mocked(storage.putDownload)
            .mock.calls.map(([stored]) => stored.status);
        expect(statuses.at(-1)).toBe('paused');
        expect(statuses).not.toContain('completed');
    });

    it('marks a response failed when it ends before the declared size', async () => {
        const { storage } = testStorage(0);
        installFetch(
            testResponse([1], 200, {
                'Content-Length': '2',
                ETag: '"version-1"',
                'X-ZenPlay-Media-Source': 'source-a',
            })
        );
        const item = downloadItem();
        item.bytesDownloaded = 0;

        await transferBrowserDownload(
            storage,
            item,
            0,
            new AbortController(),
            jest.fn()
        );

        expect(item.status).toBe('failed');
        expect(item.errorMessage).toBe(
            BROWSER_MEDIA_MESSAGES.incompleteDownload
        );
    });

    it('rejects an empty 200 response without declaring it available', async () => {
        const { storage, writer } = testStorage(0);
        installFetch(
            testResponse([], 200, {
                'X-ZenPlay-Media-Source': 'source-a',
            })
        );
        const item = downloadItem();
        item.bytesDownloaded = 0;
        item.fileAvailability = 'available';

        await transferBrowserDownload(
            storage,
            item,
            0,
            new AbortController(),
            jest.fn()
        );

        expect(item.status).toBe('failed');
        expect(item.fileAvailability).toBe('missing');
        expect(item.errorMessage).toBe(
            BROWSER_MEDIA_MESSAGES.incompleteDownload
        );
        expect(writer.close).toHaveBeenCalled();
        expect(storage.deleteFile).toHaveBeenCalledWith(item.filePath);
    });

    it('refuses resumed bytes from another media source before opening OPFS', async () => {
        const { createWritable, storage, writer } = testStorage(128);
        const fetchMock = installFetch(
            testResponse([1, 2], 206, {
                'Content-Range': 'bytes 128-129/130',
                ETag: '"version-1"',
                'X-ZenPlay-Media-Source': 'source-b',
            })
        );
        const item = downloadItem();

        await transferBrowserDownload(
            storage,
            item,
            128,
            new AbortController(),
            jest.fn()
        );

        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
            headers: {
                Range: 'bytes=128-',
                'If-Range': '"version-1"',
                'x-zenplay-expected-media-source': 'source-a',
            },
        });
        expect(createWritable).not.toHaveBeenCalled();
        expect(writer.write).not.toHaveBeenCalled();
        expect(item.status).toBe('failed');
        expect(item.errorMessage).toBe(BROWSER_MEDIA_MESSAGES.sourceChanged);
    });
});
