import { AutomaticPictureInPictureService } from './automatic-picture-in-picture.service';

const ACTION = 'enterpictureinpicture';

type ActionHandler = (() => void) | null;

type TestMediaSession = {
    setActionHandler: jest.Mock<void, [string, ActionHandler]>;
};

describe('AutomaticPictureInPictureService', () => {
    let service: AutomaticPictureInPictureService;
    let mediaSession: TestMediaSession;
    let activeHandler: ActionHandler;
    let originalMediaSession: PropertyDescriptor | undefined;
    let originalPictureInPictureElement: PropertyDescriptor | undefined;
    let originalPictureInPictureEnabled: PropertyDescriptor | undefined;
    const videos: HTMLVideoElement[] = [];

    beforeEach(() => {
        activeHandler = null;
        originalMediaSession = Object.getOwnPropertyDescriptor(
            navigator,
            'mediaSession'
        );
        originalPictureInPictureElement = Object.getOwnPropertyDescriptor(
            document,
            'pictureInPictureElement'
        );
        originalPictureInPictureEnabled = Object.getOwnPropertyDescriptor(
            document,
            'pictureInPictureEnabled'
        );

        mediaSession = {
            setActionHandler: jest.fn((action, handler) => {
                if (action === ACTION) {
                    activeHandler = handler;
                }
            }),
        };
        Object.defineProperty(navigator, 'mediaSession', {
            configurable: true,
            value: mediaSession,
        });
        Object.defineProperty(document, 'pictureInPictureElement', {
            configurable: true,
            value: null,
        });
        Object.defineProperty(document, 'pictureInPictureEnabled', {
            configurable: true,
            value: true,
        });

        service = new AutomaticPictureInPictureService();
    });

    afterEach(() => {
        service.stop();
        for (const video of videos.splice(0)) {
            video.remove();
        }
        restoreProperty(navigator, 'mediaSession', originalMediaSession);
        restoreProperty(
            document,
            'pictureInPictureElement',
            originalPictureInPictureElement
        );
        restoreProperty(
            document,
            'pictureInPictureEnabled',
            originalPictureInPictureEnabled
        );
    });

    it('registers the official Media Session action and requests PiP for the most recently playing video', () => {
        service.start();
        const first = createPlayingVideo();
        const second = createPlayingVideo();

        first.video.dispatchEvent(new Event('playing'));
        second.video.dispatchEvent(new Event('playing'));
        activeHandler?.();

        expect(mediaSession.setActionHandler).toHaveBeenCalledWith(
            ACTION,
            expect.any(Function)
        );
        expect(first.request).not.toHaveBeenCalled();
        expect(second.request).toHaveBeenCalledTimes(1);
    });

    it('moves a video back to the front when it starts playing again', () => {
        service.start();
        const first = createPlayingVideo();
        const second = createPlayingVideo();

        first.video.dispatchEvent(new Event('playing'));
        second.video.dispatchEvent(new Event('playing'));
        first.video.dispatchEvent(new Event('playing'));
        activeHandler?.();

        expect(first.request).toHaveBeenCalledTimes(1);
        expect(second.request).not.toHaveBeenCalled();
    });

    it('falls back to the previous playing video after the latest one pauses', () => {
        service.start();
        const first = createPlayingVideo();
        const second = createPlayingVideo();

        first.video.dispatchEvent(new Event('playing'));
        second.video.dispatchEvent(new Event('playing'));
        second.video.dispatchEvent(new Event('pause'));
        activeHandler?.();

        expect(first.request).toHaveBeenCalledTimes(1);
        expect(second.request).not.toHaveBeenCalled();
    });

    it('prunes a detached video when another playback becomes active', () => {
        service.start();
        const first = createPlayingVideo();
        const removeEventListener = jest.spyOn(
            first.video,
            'removeEventListener'
        );
        first.video.dispatchEvent(new Event('playing'));
        first.video.remove();

        const second = createPlayingVideo();
        second.video.dispatchEvent(new Event('playing'));

        expect(removeEventListener).toHaveBeenCalledTimes(4);
    });

    it('does not request PiP just because document visibility changes', () => {
        service.start();
        const { video, request } = createPlayingVideo();
        video.dispatchEvent(new Event('playing'));

        document.dispatchEvent(new Event('visibilitychange'));

        expect(request).not.toHaveBeenCalled();
    });

    it('does not replace another element that already owns PiP', () => {
        service.start();
        const { video, request } = createPlayingVideo();
        const foreignVideo = document.createElement('video');
        Object.defineProperty(document, 'pictureInPictureElement', {
            configurable: true,
            value: foreignVideo,
        });
        video.dispatchEvent(new Event('playing'));

        activeHandler?.();

        expect(request).not.toHaveBeenCalled();
    });

    it('contains a platform rejection without changing the manual PiP path', async () => {
        service.start();
        const { video, request } = createPlayingVideo();
        request.mockRejectedValueOnce(new Error('denied'));
        video.dispatchEvent(new Event('playing'));

        expect(() => activeHandler?.()).not.toThrow();
        await Promise.resolve();

        expect(request).toHaveBeenCalledTimes(1);
    });

    it('cleans the handler and video listeners when stopped', () => {
        service.start();
        const { video, request } = createPlayingVideo();
        video.dispatchEvent(new Event('playing'));

        service.stop();
        video.dispatchEvent(new Event('playing'));

        expect(activeHandler).toBeNull();
        expect(mediaSession.setActionHandler).toHaveBeenLastCalledWith(
            ACTION,
            null
        );
        expect(request).not.toHaveBeenCalled();
    });

    it('does not let an older service clear a newer Media Session owner', () => {
        service.start();
        const newerOwner = new AutomaticPictureInPictureService();
        newerOwner.start();
        const newerHandler = activeHandler;

        service.stop();

        expect(activeHandler).toBe(newerHandler);
        expect(mediaSession.setActionHandler).toHaveBeenCalledTimes(2);

        newerOwner.stop();
        expect(activeHandler).toBeNull();
    });

    it('restores the previous handler when the newest owner detaches', () => {
        service.start();
        const previousHandler = activeHandler;
        const newerOwner = new AutomaticPictureInPictureService();
        newerOwner.start();

        newerOwner.stop();

        expect(activeHandler).toBe(previousHandler);
        expect(mediaSession.setActionHandler).toHaveBeenLastCalledWith(
            ACTION,
            previousHandler
        );
    });

    it('degrades safely when the browser rejects the action name', () => {
        mediaSession.setActionHandler.mockImplementationOnce(() => {
            throw new DOMException('unsupported', 'NotSupportedError');
        });

        expect(() => service.start()).not.toThrow();
        expect(activeHandler).toBeNull();
    });

    function createPlayingVideo(): {
        video: HTMLVideoElement;
        request: jest.Mock<Promise<PictureInPictureWindow>, []>;
    } {
        const video = document.createElement('video');
        const request = jest
            .fn<Promise<PictureInPictureWindow>, []>()
            .mockResolvedValue({} as PictureInPictureWindow);
        Object.defineProperties(video, {
            paused: { configurable: true, value: false },
            ended: { configurable: true, value: false },
            readyState: {
                configurable: true,
                value: HTMLMediaElement.HAVE_METADATA,
            },
            requestPictureInPicture: {
                configurable: true,
                value: request,
            },
        });
        document.body.appendChild(video);
        videos.push(video);
        return { video, request };
    }
});

function restoreProperty(
    target: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor | undefined
): void {
    if (descriptor) {
        Object.defineProperty(target, key, descriptor);
        return;
    }
    delete (target as Record<PropertyKey, unknown>)[key];
}
