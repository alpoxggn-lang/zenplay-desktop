import type { WebVideoRemotePlaybackResumeState } from './web-video-remote-playback-host';

type Listen = (
    target: EventTarget,
    eventName: string,
    listener: EventListener
) => void;

interface LocalPlaybackSnapshot extends WebVideoRemotePlaybackResumeState {
    readonly positionSeconds: number;
}

/** Owns the explicit playback snapshot exchanged with a remote renderer. */
export class WebVideoRemotePlaybackSync {
    private localSnapshot: LocalPlaybackSnapshot | null = null;
    private remotePlaying = false;
    private remotePositionObserved = false;
    private active = false;

    constructor(
        private readonly source: HTMLVideoElement,
        private readonly remote: HTMLVideoElement,
        private readonly changed: () => void
    ) {}

    attach(listen: Listen): void {
        for (const eventName of [
            'durationchange',
            'ended',
            'loadedmetadata',
            'pause',
            'play',
            'playing',
            'ratechange',
            'seeking',
            'seeked',
            'timeupdate',
            'volumechange',
            'waiting',
        ]) {
            listen(this.remote, eventName, () => {
                if (!this.active) return;
                if (eventName === 'play' || eventName === 'playing') {
                    this.remotePlaying = true;
                } else if (eventName === 'pause' || eventName === 'ended') {
                    this.remotePlaying = false;
                }
                if (eventName === 'timeupdate' || eventName === 'seeked') {
                    this.remotePositionObserved = true;
                }
                this.changed();
            });
        }
    }

    preparePrompt(): void {
        this.localSnapshot = this.readLocalSnapshot();
        this.applySnapshot(this.localSnapshot);
    }

    begin(): WebVideoRemotePlaybackResumeState {
        if (this.active) return this.readRemoteState();
        const snapshot = this.localSnapshot ?? this.readLocalSnapshot();
        this.localSnapshot = snapshot;
        this.remotePlaying = snapshot.playing;
        this.remotePositionObserved = false;
        this.active = true;
        this.applySnapshot(snapshot);
        this.source.muted = true;
        this.source.pause();
        if (snapshot.playing) {
            void this.remote.play().catch(() => undefined);
        } else {
            this.remote.pause();
        }
        return snapshot;
    }

    finish(includePosition = true): WebVideoRemotePlaybackResumeState {
        const local = this.localSnapshot ?? this.readLocalSnapshot();
        const remotePosition = this.remote.currentTime;
        const hasPosition =
            includePosition &&
            this.remotePositionObserved &&
            Number.isFinite(remotePosition) &&
            remotePosition >= 0;
        const state: WebVideoRemotePlaybackResumeState = {
            muted: this.remote.muted,
            playbackRate: finiteOr(this.remote.playbackRate, 1),
            playing: this.remotePlaying,
            ...(hasPosition ? { positionSeconds: remotePosition } : {}),
            volume: finiteOr(this.remote.volume, local.volume),
        };
        this.active = false;
        this.remotePositionObserved = false;
        this.localSnapshot = null;
        return state;
    }

    private readRemoteState(): WebVideoRemotePlaybackResumeState {
        return {
            muted: this.remote.muted,
            playbackRate: finiteOr(this.remote.playbackRate, 1),
            playing: this.remotePlaying,
            volume: finiteOr(this.remote.volume, 1),
        };
    }

    restoreSource(state: WebVideoRemotePlaybackResumeState): void {
        this.source.volume = state.volume;
        this.source.muted = state.muted;
        this.source.playbackRate = state.playbackRate;
        if (state.positionSeconds !== undefined) {
            this.applyPosition(state.positionSeconds, this.source);
        }
        if (state.playing) {
            void this.source.play().catch(() => undefined);
        } else {
            this.source.pause();
        }
    }

    private applySnapshot(snapshot: LocalPlaybackSnapshot): void {
        this.applyPosition(snapshot.positionSeconds, this.remote);
        this.remote.volume = snapshot.volume;
        this.remote.muted = snapshot.muted;
        this.remote.playbackRate = snapshot.playbackRate;
    }

    private readLocalSnapshot(): LocalPlaybackSnapshot {
        return {
            muted: this.source.muted,
            playbackRate: finiteOr(this.source.playbackRate, 1),
            playing: !this.source.paused && !this.source.ended,
            positionSeconds: Math.max(0, finiteOr(this.source.currentTime, 0)),
            volume: finiteOr(this.source.volume, 1),
        };
    }

    private applyPosition(seconds: number, target: HTMLVideoElement): void {
        if (!Number.isFinite(seconds)) return;
        try {
            target.currentTime = Math.max(0, seconds);
        } catch {
            // Live/not-yet-loaded elements can reject a position assignment.
        }
    }
}

function finiteOr(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}
