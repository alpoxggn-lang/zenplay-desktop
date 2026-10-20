import type {
    WebkitPlaybackTargetAvailabilityEvent,
    WebkitRemoteVideo,
} from './web-video-remote-playback-state';

interface RemotePlaybackListenersConfig {
    listen: (
        target: EventTarget,
        eventName: string,
        listener: EventListener
    ) => void;
    onAvailability: (available: boolean | null) => void;
    onConnect: () => void;
    onConnecting: () => void;
    onDisconnect: () => void;
    remote: RemotePlayback | null;
    video: WebkitRemoteVideo;
}

/** Binds standard Remote Playback and Safari AirPlay lifecycle events. */
export function attachWebVideoRemotePlaybackListeners(
    config: RemotePlaybackListenersConfig
): void {
    if (config.remote) {
        config.listen(config.remote, 'connecting', config.onConnecting);
        config.listen(config.remote, 'connect', config.onConnect);
        config.listen(config.remote, 'disconnect', config.onDisconnect);
    }
    config.listen(
        config.video,
        'webkitplaybacktargetavailabilitychanged',
        (event) => {
            const availability = (
                event as WebkitPlaybackTargetAvailabilityEvent
            ).availability;
            config.onAvailability(
                availability === undefined
                    ? null
                    : availability === 'available'
            );
        }
    );
    config.listen(
        config.video,
        'webkitcurrentplaybacktargetiswirelesschanged',
        () => {
            if (config.video.webkitCurrentPlaybackTargetIsWireless) {
                config.onConnect();
            } else {
                config.onDisconnect();
            }
        }
    );
}
