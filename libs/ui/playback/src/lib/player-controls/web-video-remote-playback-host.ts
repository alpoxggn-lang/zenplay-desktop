export interface WebVideoRemotePlaybackResumeState {
    readonly muted: boolean;
    readonly playbackRate: number;
    readonly playing: boolean;
    /** Omitted until the remote element produced trustworthy position evidence. */
    readonly positionSeconds?: number;
    readonly volume: number;
}

/** Optional extension implemented by web-video controllers that can cast. */
export interface WebVideoRemotePlaybackHost {
    beginRemotePlayback(
        video: HTMLVideoElement,
        state: WebVideoRemotePlaybackResumeState
    ): void;
    finishRemotePlayback(
        state: WebVideoRemotePlaybackResumeState,
        restoreLocal: boolean
    ): void;
}

export function isWebVideoRemotePlaybackHost(
    value: unknown
): value is WebVideoRemotePlaybackHost {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<WebVideoRemotePlaybackHost>;
    return (
        typeof candidate.beginRemotePlayback === 'function' &&
        typeof candidate.finishRemotePlayback === 'function'
    );
}
