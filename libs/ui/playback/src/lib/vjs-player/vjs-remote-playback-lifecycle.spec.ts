import { VjsRemotePlaybackLifecycle } from './vjs-remote-playback-lifecycle';

describe('VjsRemotePlaybackLifecycle', () => {
    it('resets the local engine while casting and restores receiver state', () => {
        const video = document.createElement('video');
        Object.defineProperties(video, {
            readyState: { configurable: true, value: 4 },
            currentTime: { configurable: true, value: 0, writable: true },
            pause: { configurable: true, value: jest.fn() },
            play: {
                configurable: true,
                value: jest.fn().mockResolvedValue(undefined),
            },
        });
        const config = {
            bindCurrentVideo: jest.fn(() => video),
            clearControlsSource: jest.fn(),
            clearSourceApplied: jest.fn(),
            destroyMpegTs: jest.fn(),
            queueTask: jest.fn((task: () => void) => task()),
            requestReset: jest.fn(),
            restoreDesiredSource: jest.fn(),
        };
        const lifecycle = new VjsRemotePlaybackLifecycle(config);

        lifecycle.suspend();
        lifecycle.suspend();

        expect(lifecycle.suspended).toBe(true);
        expect(config.clearControlsSource).toHaveBeenCalledTimes(1);
        expect(config.destroyMpegTs).toHaveBeenCalledTimes(1);
        expect(config.clearSourceApplied).toHaveBeenCalledTimes(1);
        expect(config.requestReset).toHaveBeenCalledTimes(1);

        lifecycle.restore({
            muted: true,
            playbackRate: 1.25,
            playing: true,
            positionSeconds: 42,
            volume: 0.5,
        });

        expect(lifecycle.suspended).toBe(false);
        expect(config.restoreDesiredSource).toHaveBeenCalledTimes(1);
        expect(video.currentTime).toBe(42);
        expect(video.muted).toBe(true);
        expect(video.volume).toBe(0.5);
        expect(video.playbackRate).toBe(1.25);
        expect(video.play).toHaveBeenCalledTimes(1);
        lifecycle.destroy();
    });
});
