import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import { captureBrowserDownloadSourceId } from './browser-download-source';

describe('captureBrowserDownloadSourceId', () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

    afterEach(() => {
        jest.restoreAllMocks();
        if (originalFetch) {
            Object.defineProperty(globalThis, 'fetch', originalFetch);
        } else {
            delete (globalThis as { fetch?: typeof fetch }).fetch;
        }
    });

    it('reads the opaque identity from the media-session source endpoint', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            headers: new Headers({
                'X-ZenPlay-Media-Source': 'source-a',
            }),
            ok: true,
            status: 204,
        } as Response);
        Object.defineProperty(globalThis, 'fetch', {
            configurable: true,
            value: fetchMock,
        });

        await expect(
            captureBrowserDownloadSourceId('/api/media/movie/42.mp4')
        ).resolves.toBe('source-a');
        expect(fetchMock).toHaveBeenCalledWith('/api/media/source', {
            credentials: 'include',
        });
    });

    it('fails closed when the backend does not confirm a source identity', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            headers: new Headers(),
            ok: true,
            status: 204,
        } as Response);
        Object.defineProperty(globalThis, 'fetch', {
            configurable: true,
            value: fetchMock,
        });

        await expect(
            captureBrowserDownloadSourceId('/api/media/series/42.mp4')
        ).rejects.toThrow(BROWSER_MEDIA_MESSAGES.sourceUnconfirmed);
    });
});
