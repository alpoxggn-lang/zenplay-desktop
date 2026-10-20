import { RemotePlaybackTicketError } from './web-video-remote-playback-ticket';

export interface WebkitRemoteVideo extends HTMLVideoElement {
    webkitCurrentPlaybackTargetIsWireless?: boolean;
    webkitShowPlaybackTargetPicker?: () => void;
}

export interface WebkitPlaybackTargetAvailabilityEvent extends Event {
    readonly availability?: 'available' | 'not-available';
}

export interface WebVideoRemotePlaybackState {
    readonly active: boolean;
    readonly available: boolean | null;
    readonly canPrompt: boolean;
    readonly preparing: boolean;
    readonly retrying: boolean;
    readonly supported: boolean;
}

export const EMPTY_REMOTE_PLAYBACK_STATE: WebVideoRemotePlaybackState = {
    active: false,
    available: null,
    canPrompt: false,
    preparing: false,
    retrying: false,
    supported: false,
};

export const WEBKIT_PICKER_TIMEOUT_MS = 30_000;
export const DEFAULT_PREPARE_RETRY_MS = 5_000;

export function isRecoverableTicketError(error: unknown): boolean {
    return error instanceof RemotePlaybackTicketError
        ? error.recoverable
        : error instanceof TypeError;
}

export function readRemotePlayback(
    video: HTMLVideoElement
): RemotePlayback | null {
    try {
        const remote = video.remote;
        return remote && typeof remote.prompt === 'function' ? remote : null;
    } catch {
        return null;
    }
}

export function isRemotePlaybackActive(
    video: WebkitRemoteVideo | null,
    remote: RemotePlayback | null
): boolean {
    return (
        remote?.state === 'connected' ||
        video?.webkitCurrentPlaybackTargetIsWireless === true
    );
}
