import {
    BrowserMediaLibrary,
    resolvePrivateBrowserMediaUrl,
    responseMatchesRequestedRange,
    supportsBrowserLiveRecording,
    supportsBrowserPrivateMediaStorage,
} from './browser-media-library';
import { BrowserPrivateStorage } from './browser-media-library/browser-private-storage';

describe('browser media library capability and URL safety', () => {
    const originalStorage = Object.getOwnPropertyDescriptor(
        navigator,
        'storage'
    );
    const originalCaptureStream = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'captureStream'
    );
    const originalMediaRecorder = Object.getOwnPropertyDescriptor(
        globalThis,
        'MediaRecorder'
    );
    const originalIndexedDb = Object.getOwnPropertyDescriptor(
        globalThis,
        'indexedDB'
    );

    beforeEach(() => {
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: undefined,
            writable: true,
        });
        delete window.__IPTVNATOR_CONFIG__;
    });

    afterEach(() => {
        if (originalStorage) {
            Object.defineProperty(navigator, 'storage', originalStorage);
        } else {
            Reflect.deleteProperty(navigator, 'storage');
        }
        if (originalCaptureStream) {
            Object.defineProperty(
                HTMLMediaElement.prototype,
                'captureStream',
                originalCaptureStream
            );
        } else {
            delete (
                HTMLMediaElement.prototype as HTMLMediaElement & {
                    captureStream?: () => MediaStream;
                }
            ).captureStream;
        }
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
        if (originalIndexedDb) {
            Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
        } else {
            delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
        }
    });

    it('rewrites provider movie and episode URLs to opaque backend routes', () => {
        window.__IPTVNATOR_CONFIG__ = { BACKEND_URL: '/api' };

        expect(
            resolvePrivateBrowserMediaUrl(
                'https://provider.example/movie/alice/secret/42.MKV?token=leak'
            )
        ).toBe('/api/media/movie/42.mkv');
        expect(
            resolvePrivateBrowserMediaUrl(
                'https://provider.example/series/alice/secret/91.mp4'
            )
        ).toBe('/api/media/series/91.mp4');
        expect(
            resolvePrivateBrowserMediaUrl(
                'https://provider.example/base/series/u@ser/p/a/92.mp4'
            )
        ).toBe('/api/media/series/92.mp4');
    });

    it('accepts only the configured same-origin opaque media route', () => {
        window.__IPTVNATOR_CONFIG__ = { BACKEND_URL: '/api' };

        expect(resolvePrivateBrowserMediaUrl('/api/media/movie/42.mp4')).toBe(
            '/api/media/movie/42.mp4'
        );
        expect(
            resolvePrivateBrowserMediaUrl('/untrusted/api/media/movie/42.mp4')
        ).toBeNull();
        expect(
            resolvePrivateBrowserMediaUrl(
                'https://other.example/api/media/movie/42.mp4'
            )
        ).toBeNull();
        expect(
            resolvePrivateBrowserMediaUrl(
                'https://provider.example/live/alice/secret/42.ts'
            )
        ).toBeNull();
    });

    it('never enables browser storage inside Electron', () => {
        Object.defineProperty(navigator, 'storage', {
            configurable: true,
            value: { getDirectory: jest.fn() },
        });
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: {},
            writable: true,
        });

        expect(supportsBrowserPrivateMediaStorage()).toBe(false);
        expect(supportsBrowserLiveRecording()).toBe(false);
    });

    it('detects private storage and live capture only when both APIs exist', () => {
        Object.defineProperty(globalThis, 'indexedDB', {
            configurable: true,
            value: {},
        });
        Object.defineProperty(navigator, 'storage', {
            configurable: true,
            value: { getDirectory: jest.fn() },
        });
        Object.defineProperty(HTMLMediaElement.prototype, 'captureStream', {
            configurable: true,
            value: jest.fn(),
        });
        Object.defineProperty(globalThis, 'MediaRecorder', {
            configurable: true,
            value: class TestMediaRecorder {},
        });

        expect(supportsBrowserPrivateMediaStorage()).toBe(true);
        expect(supportsBrowserLiveRecording()).toBe(true);
    });
});

describe('responseMatchesRequestedRange', () => {
    it('accepts an exact 206 range and rejects mismatched or ignored ranges', () => {
        expect(
            responseMatchesRequestedRange(
                {
                    status: 206,
                    headers: new Headers({
                        'Content-Range': 'bytes 128-255/1024',
                    }),
                },
                128
            )
        ).toBe(true);
        expect(
            responseMatchesRequestedRange(
                {
                    status: 206,
                    headers: new Headers({
                        'Content-Range': 'bytes 0-255/1024',
                    }),
                },
                128
            )
        ).toBe(false);
        expect(
            responseMatchesRequestedRange(
                { status: 200, headers: new Headers() },
                128
            )
        ).toBe(false);
    });

    it('allows a complete response when no resume offset was requested', () => {
        expect(
            responseMatchesRequestedRange(
                { status: 200, headers: new Headers() },
                0
            )
        ).toBe(true);
        expect(
            responseMatchesRequestedRange(
                {
                    status: 206,
                    headers: new Headers({
                        'Content-Range': 'bytes 64-255/1024',
                    }),
                },
                0
            )
        ).toBe(false);
    });
});

describe('BrowserMediaLibrary initialization', () => {
    const originalStorage = Object.getOwnPropertyDescriptor(
        navigator,
        'storage'
    );
    const originalIndexedDb = Object.getOwnPropertyDescriptor(
        globalThis,
        'indexedDB'
    );
    const originalElectron = Object.getOwnPropertyDescriptor(
        window,
        'electron'
    );

    afterEach(() => {
        jest.restoreAllMocks();
        if (originalStorage) {
            Object.defineProperty(navigator, 'storage', originalStorage);
        } else {
            Reflect.deleteProperty(navigator, 'storage');
        }
        if (originalIndexedDb) {
            Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
        } else {
            delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
        }
        if (originalElectron) {
            Object.defineProperty(window, 'electron', originalElectron);
        } else {
            delete (window as { electron?: unknown }).electron;
        }
    });

    it('allows retry after a transient private-storage failure', async () => {
        Object.defineProperty(globalThis, 'indexedDB', {
            configurable: true,
            value: {},
        });
        Object.defineProperty(navigator, 'storage', {
            configurable: true,
            value: { getDirectory: jest.fn(), persist: jest.fn() },
        });
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: undefined,
        });
        const persistence = jest
            .spyOn(BrowserPrivateStorage.prototype, 'requestPersistence')
            .mockRejectedValueOnce(new Error('temporary IndexedDB failure'))
            .mockResolvedValue(undefined);
        jest.spyOn(
            BrowserPrivateStorage.prototype,
            'listDownloads'
        ).mockResolvedValue([]);
        jest.spyOn(
            BrowserPrivateStorage.prototype,
            'listRecordings'
        ).mockResolvedValue([]);
        const library = new BrowserMediaLibrary();

        await expect(library.initialize()).rejects.toThrow(
            'temporary IndexedDB failure'
        );
        await expect(library.initialize()).resolves.toBeUndefined();
        expect(persistence).toHaveBeenCalledTimes(2);
    });

    it('retries opening IndexedDB after the first open request fails', async () => {
        const open = jest
            .fn()
            .mockImplementationOnce(() => {
                const request: Partial<IDBOpenDBRequest> = {
                    error: new DOMException('temporary failure'),
                };
                queueMicrotask(() =>
                    request.onerror?.call(
                        request as IDBOpenDBRequest,
                        new Event('error')
                    )
                );
                return request;
            })
            .mockImplementationOnce(() => {
                const readRequest: Partial<IDBRequest<unknown[]>> = {
                    result: [],
                };
                const database = {
                    transaction: () => ({
                        objectStore: () => ({
                            getAll: () => {
                                queueMicrotask(() =>
                                    readRequest.onsuccess?.call(
                                        readRequest as IDBRequest<unknown[]>,
                                        new Event('success')
                                    )
                                );
                                return readRequest;
                            },
                        }),
                    }),
                };
                const request: Partial<IDBOpenDBRequest> = {
                    result: database as unknown as IDBDatabase,
                };
                queueMicrotask(() =>
                    request.onsuccess?.call(
                        request as IDBOpenDBRequest,
                        new Event('success')
                    )
                );
                return request;
            });
        Object.defineProperty(globalThis, 'indexedDB', {
            configurable: true,
            value: { open },
        });
        const storage = new BrowserPrivateStorage();

        await expect(storage.listDownloads()).rejects.toThrow(
            'temporary failure'
        );
        await expect(storage.listDownloads()).resolves.toEqual([]);
        expect(open).toHaveBeenCalledTimes(2);
    });
});

describe('BrowserPrivateStorage file deletion', () => {
    function storageWithRemoval(error: DOMException): BrowserPrivateStorage {
        const storage = new BrowserPrivateStorage();
        Object.defineProperty(storage, 'rootDirectory', {
            configurable: true,
            value: async () => ({
                getDirectoryHandle: async () => ({
                    removeEntry: async () => {
                        throw error;
                    },
                }),
            }),
        });
        return storage;
    }

    it('treats an already-evicted OPFS file as an idempotent removal', async () => {
        const storage = storageWithRemoval(
            new DOMException('Missing', 'NotFoundError')
        );

        await expect(
            storage.deleteFile(
                'opfs://zenplay-private-media/downloads/already-gone.mp4'
            )
        ).resolves.toBeUndefined();
    });

    it('surfaces real OPFS failures instead of deleting the metadata row', async () => {
        const storage = storageWithRemoval(
            new DOMException('Denied', 'NotAllowedError')
        );

        await expect(
            storage.deleteFile(
                'opfs://zenplay-private-media/downloads/protected.mp4'
            )
        ).rejects.toMatchObject({ name: 'NotAllowedError' });
    });
});
