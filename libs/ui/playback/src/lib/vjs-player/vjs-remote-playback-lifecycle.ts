import type { WebVideoRemotePlaybackResumeState } from '../player-controls/web-video-remote-playback-host';
import { restoreWebVideoAfterRemotePlayback } from '../web-video-support/web-video-remote-resume';

interface VjsRemotePlaybackLifecycleConfig {
    bindCurrentVideo: () => HTMLVideoElement | null;
    clearControlsSource: () => void;
    clearSourceApplied: () => void;
    destroyMpegTs: () => void;
    queueTask: (task: () => void) => void;
    requestReset: () => void;
    restoreDesiredSource: () => void;
}

/** Releases the Video.js source while casting and rebuilds it on return. */
export class VjsRemotePlaybackLifecycle {
    private isSuspendedValue = false;
    private restoreCleanup: (() => void) | null = null;

    constructor(private readonly config: VjsRemotePlaybackLifecycleConfig) {}

    get suspended(): boolean {
        return this.isSuspendedValue;
    }

    suspend(): void {
        if (this.isSuspendedValue) return;
        this.restoreCleanup?.();
        this.restoreCleanup = null;
        this.isSuspendedValue = true;
        this.config.clearControlsSource();
        this.config.destroyMpegTs();
        this.config.clearSourceApplied();
        this.config.requestReset();
    }

    restore(state: WebVideoRemotePlaybackResumeState): void {
        this.isSuspendedValue = false;
        this.config.restoreDesiredSource();
        const video = this.config.bindCurrentVideo();
        if (video) {
            this.restoreOn(video, state);
            return;
        }
        this.config.queueTask(() => {
            const retryVideo = this.config.bindCurrentVideo();
            if (retryVideo) this.restoreOn(retryVideo, state);
        });
    }

    destroy(): void {
        this.restoreCleanup?.();
        this.restoreCleanup = null;
        this.isSuspendedValue = false;
    }

    private restoreOn(
        video: HTMLVideoElement,
        state: WebVideoRemotePlaybackResumeState
    ): void {
        this.restoreCleanup?.();
        this.restoreCleanup = restoreWebVideoAfterRemotePlayback(video, state);
    }
}
