import { signal } from '@angular/core';
import { WebVideoSourceTracks } from '../web-video-support/web-video-source-tracks';
import type { PlayerStatus, PlayerTrack } from './player-controls.model';
import { WEB_VIDEO_EVENTS } from './web-video-controls.media-helpers';
import type { WebVideoRemotePlaybackResumeState } from './web-video-remote-playback-host';

/** Owns the temporary remote media element exposed through shared controls. */
export class WebVideoControlsRemoteSession {
    readonly video = signal<HTMLVideoElement | null>(null);
    readonly status = signal<PlayerStatus>('idle');
    private tracks: WebVideoSourceTracks | null = null;
    private detachEvents: (() => void) | null = null;

    begin(
        video: HTMLVideoElement,
        state: WebVideoRemotePlaybackResumeState,
        refresh: () => void
    ): void {
        if (this.video() === video) return;
        this.clear();
        this.video.set(video);
        this.status.set(state.playing ? 'playing' : 'paused');
        this.tracks = new WebVideoSourceTracks({
            video,
            showCaptions: () => true,
            refresh,
        });
        this.tracks.setSource({ kind: 'native' });
        const onEvent = (event: Event) => {
            this.updateStatus(video, event.type);
            refresh();
        };
        for (const eventName of WEB_VIDEO_EVENTS) {
            video.addEventListener(eventName, onEvent);
        }
        this.detachEvents = () => {
            for (const eventName of WEB_VIDEO_EVENTS) {
                video.removeEventListener(eventName, onEvent);
            }
        };
    }

    clear(): void {
        this.detachEvents?.();
        this.detachEvents = null;
        this.tracks?.destroy();
        this.tracks = null;
        this.video.set(null);
        this.status.set('idle');
    }

    audioTracks(): PlayerTrack[] {
        return this.tracks?.getAudioTracks() ?? [];
    }

    subtitleTracks(): PlayerTrack[] {
        return this.tracks?.getSubtitleTracks() ?? [];
    }

    setAudioTrack(id: number): void {
        this.tracks?.setAudioTrack(id);
    }

    setSubtitleTrack(id: number): void {
        this.tracks?.setSubtitleTrack(id);
    }

    togglePlay(): void {
        const video = this.video();
        if (!video) return;
        if (this.status() === 'playing' || this.status() === 'loading') {
            this.status.set('paused');
            video.pause();
        } else {
            this.status.set('loading');
            void video.play().catch(() => this.status.set('error'));
        }
    }

    private updateStatus(video: HTMLVideoElement, eventName: string): void {
        if (eventName === 'error') this.status.set('error');
        else if (eventName === 'ended') this.status.set('ended');
        else if (eventName === 'pause') this.status.set('paused');
        else if (eventName === 'waiting' || eventName === 'stalled') {
            this.status.set('loading');
        } else if (eventName === 'play' || eventName === 'playing') {
            this.status.set('playing');
        } else if (eventName === 'emptied' && video.networkState === 0) {
            this.status.set('idle');
        }
    }
}
