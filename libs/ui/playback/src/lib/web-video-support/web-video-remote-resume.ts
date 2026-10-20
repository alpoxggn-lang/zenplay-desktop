import type { WebVideoRemotePlaybackResumeState } from '../player-controls/web-video-remote-playback-host';

/**
 * Applies a remote receiver snapshot after an engine has reloaded its local
 * source. A missing position is intentional: never reset a VOD to zero merely
 * because the remote element had not reported a real position yet.
 */
export function restoreWebVideoAfterRemotePlayback(
    video: HTMLVideoElement,
    state: WebVideoRemotePlaybackResumeState
): () => void {
    video.volume = clamp(state.volume, 0, 1);
    video.muted = state.muted;
    video.playbackRate = clamp(state.playbackRate, 0.25, 4);

    let restored = false;
    const restore = () => {
        if (restored) return;
        if (
            state.positionSeconds !== undefined &&
            Number.isFinite(state.positionSeconds)
        ) {
            try {
                video.currentTime = Math.max(0, state.positionSeconds);
            } catch {
                return;
            }
        }
        restored = true;
        cleanup();
        if (state.playing) {
            void video.play().catch(() => undefined);
        } else {
            video.pause();
        }
    };
    const cleanup = () => {
        video.removeEventListener('loadedmetadata', restore);
        video.removeEventListener('canplay', restore);
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        restore();
    } else {
        video.addEventListener('loadedmetadata', restore);
        video.addEventListener('canplay', restore);
        // A live/native source may never expose seekable metadata but can
        // still resume immediately when no position has to be restored.
        if (state.positionSeconds === undefined) restore();
    }
    return cleanup;
}

function clamp(value: number, min: number, max: number): number {
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}
