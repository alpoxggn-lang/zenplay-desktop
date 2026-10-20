import { openBrowserPrivateMedia } from './browser-private-player';

describe('openBrowserPrivateMedia', () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;

    beforeEach(() => {
        document.body.replaceChildren();
        URL.createObjectURL = jest
            .fn()
            .mockReturnValueOnce('blob:first')
            .mockReturnValueOnce('blob:second');
        URL.revokeObjectURL = jest.fn();
        jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation();
        jest.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation();
    });

    afterEach(() => {
        document.body.replaceChildren();
        URL.createObjectURL = originalCreateObjectUrl;
        URL.revokeObjectURL = originalRevokeObjectUrl;
        jest.restoreAllMocks();
    });

    it('fully disposes the previous overlay before opening another file', () => {
        openBrowserPrivateMedia(
            new File(['one'], 'one.mp4'),
            'First',
            'Close'
        );
        const firstVideo = document.querySelector('video');

        openBrowserPrivateMedia(
            new File(['two'], 'two.mp4'),
            'Second',
            'Close'
        );

        expect(firstVideo?.getAttribute('src')).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
        expect(
            document.querySelectorAll('[data-zenplay-offline-player]')
        ).toHaveLength(1);

        const close = document.querySelector<HTMLButtonElement>('button');
        expect(close?.getAttribute('aria-label')).toBe('Close');
        close?.click();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second');
        expect(
            document.querySelector('[data-zenplay-offline-player]')
        ).toBeNull();
    });
});
