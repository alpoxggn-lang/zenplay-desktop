import type { PlaybackDiagnostic } from '@iptvnator/playback/util';
import type { PlayerTimeUpdate } from '../playback-history/player-time-update';
import {
    isAdaptiveVhsDurationFinal,
    resolveAdaptiveProgressiveStartTime,
} from '../web-video-support/adaptive-hls-load-policy';
import { logVjsAudioTracks, setupVjsAudioTrackMenu } from './vjs-audio-tracks';
import { createVideoJsPlaybackDiagnostic } from './vjs-playback-diagnostics';
import {
    getVideoJsVhsEndList,
    type VideoJsPlayer,
    type VideoPlayerSource,
} from './vjs-player.types';

const emptyTimeRanges: TimeRanges = {
    length: 0,
    start: () => 0,
    end: () => 0,
};

interface VjsPlayerEventsOptions {
    readonly getPlayer: () => VideoJsPlayer;
    readonly getSource: () => VideoPlayerSource | null;
    readonly getBoundVideo: () => HTMLVideoElement | null;
    readonly getFallbackVideo: () => HTMLVideoElement;
    readonly bindCurrentVideo: () => HTMLVideoElement | null;
    readonly getStartTime: () => number;
    readonly getFallbackVolume: () => number;
    readonly shouldSuppressVolumeChange: () => boolean;
    readonly syncMpegTsDuration: () => void;
    readonly bindLegacyTracks: () => void;
    readonly refreshControls: () => void;
    readonly emitPlaybackIssue: (diagnostic: PlaybackDiagnostic | null) => void;
    readonly emitTimeUpdate: (update: PlayerTimeUpdate) => void;
}

/** Owns the metadata, diagnostics and progress events emitted by Video.js. */
export class VjsPlayerEvents {
    constructor(private readonly options: VjsPlayerEventsOptions) {}

    readonly loadedMetadata = (): void => {
        const player = this.options.getPlayer();
        const source = this.options.getSource();
        const video = this.options.bindCurrentVideo();
        const startTime = this.options.getStartTime();
        if (startTime > 0) {
            player.currentTime(
                resolveAdaptiveProgressiveStartTime(
                    source?.src ?? '',
                    startTime,
                    video?.seekable ?? emptyTimeRanges
                )
            );
        }
        this.options.emitPlaybackIssue(null);
        this.options.bindLegacyTracks();
        logVjsAudioTracks(player);
        setupVjsAudioTrackMenu(player);
        this.options.refreshControls();
    };

    readonly videoJsError = (): void => {
        const player = this.options.getPlayer();
        const video =
            this.options.getBoundVideo() ?? this.options.getFallbackVideo();
        this.options.syncMpegTsDuration();
        this.options.emitPlaybackIssue(
            createVideoJsPlaybackDiagnostic(
                player,
                this.options.getSource(),
                video
            )
        );
    };

    readonly volumeChange = (): void => {
        if (this.options.shouldSuppressVolumeChange()) return;
        const currentVolume =
            this.options.getPlayer().volume() ??
            this.options.getFallbackVolume();
        localStorage.setItem('volume', currentVolume.toString());
    };

    readonly timeUpdate = (): void => {
        const player = this.options.getPlayer();
        const source = this.options.getSource();
        this.options.emitTimeUpdate({
            currentTime: player.currentTime() ?? 0,
            duration: player.duration() ?? 0,
            durationFinal: isAdaptiveVhsDurationFinal(
                source?.src ?? '',
                getVideoJsVhsEndList(player)
            ),
            playing: !player.paused() && !player.seeking(),
        });
    };
}
