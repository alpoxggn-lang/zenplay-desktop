import { Injectable, type Signal, computed, signal } from '@angular/core';
import { browserMediaLibrary } from '@iptvnator/services';
import type { RecordingStartMetadata } from '@iptvnator/shared/interfaces';
import {
    createEmptyControlsState,
    DEFAULT_ASPECT_PRESETS,
    DEFAULT_PLAYER_CAPABILITIES,
    DEFAULT_SPEED_PRESETS,
} from './player-controls-defaults';
import type {
    PlayerController,
    PlayerControlsCapabilities,
    PlayerControlsCommands,
    PlayerControlsState,
    PlayerSubtitleStyle,
    PlayerTrack,
} from './player-controls.model';
import { DEFAULT_SUBTITLE_STYLE } from './subtitle-style';
import type { SeriesPlaybackNavigation } from '../portal-inline-player/series-playback-navigation';
import {
    applyTrackSelection,
    applyVideoCurrentTime,
    applyVideoSpeed,
    applyVideoVolume,
    hasSeekableRange,
    isVideoStalled,
    mapVideoStatus,
    normalizeVideoDuration,
    readVideoDuration,
    readVideoIsLive,
    readVideoVolume,
    toggleVideoPlay,
    type WebVideoMetadataOptions,
    WEB_VIDEO_EVENTS,
} from './web-video-controls.media-helpers';
import { WebVideoPictureInPictureController } from './web-video-picture-in-picture.controller';
import type {
    WebVideoRemotePlaybackHost,
    WebVideoRemotePlaybackResumeState,
} from './web-video-remote-playback-host';
import { WebVideoControlsRemoteSession } from './web-video-controls-remote-session';
import { restoreWebVideoAfterRemotePlayback } from '../web-video-support/web-video-remote-resume';
import {
    type WebVideoEngineStats,
    WebVideoStreamStatsSampler,
} from './web-video-stream-stats';

/**
 * Engine-agnostic accessors a web engine injects so the adapter can read/select
 * audio & subtitle tracks without importing hls.js/videojs/artplayer.
 */
export interface WebVideoControlsOptions extends WebVideoMetadataOptions {
    /** Snapshot used to label a browser-side live-TV recording. */
    getRecordingMetadata?: () => RecordingStartMetadata | null;
    getAudioTracks?: () => PlayerTrack[];
    setAudioTrack?: (id: number) => void | Promise<void>;
    getSubtitleTracks?: () => PlayerTrack[];
    setSubtitleTrack?: (id: number) => void | Promise<void>;
    /** Opens the engine's subtitle file picker; loads + selects the pick. */
    addExternalSubtitleFile?: () => void;
    getSubtitleDelay?: () => number;
    setSubtitleDelay?: (seconds: number) => void | Promise<void>;
    /** Runtime gate for the delay UI (e.g. only once a file is loaded). */
    canAdjustSubtitleDelay?: () => boolean;
    getSubtitleStyle?: () => PlayerSubtitleStyle;
    setSubtitleStyle?: (style: PlayerSubtitleStyle) => void | Promise<void>;
    getQualityLevels?: () => PlayerTrack[];
    setQualityLevel?: (id: number) => void | Promise<void>;
    isAutoQualityEnabled?: () => boolean;
    /**
     * Bitrate/codec/container of the active rendition. Optional: the element
     * itself covers resolution, frame rate, buffer and dropped frames, so an
     * engine without a manifest simply reports fewer rows.
     */
    getEngineStats?: () => WebVideoEngineStats | null;
    /** Stops the local engine/network connection after a receiver connects. */
    suspendForRemotePlayback?: () => void;
    /** Rebuilds the local engine after the receiver disconnects. */
    restoreAfterRemotePlayback?: (
        state: WebVideoRemotePlaybackResumeState
    ) => void;
}

interface WebVideoControlsContext {
    seriesNavigation: Signal<SeriesPlaybackNavigation | null>;
}

/**
 * Can bridge any `<video>`-backed web engine onto the generic
 * {@link PlayerController} contract using only DOM/video APIs.
 */
@Injectable()
export class WebVideoControlsAdapter
    implements PlayerController, WebVideoRemotePlaybackHost
{
    private video: HTMLVideoElement | null = null;
    private opts: WebVideoControlsOptions = {};
    private detachFn: (() => void) | null = null;
    private unsubscribeRecording: (() => void) | null = null;
    private recordingTimer: number | null = null;
    private bindingGeneration = 0;
    private readonly remote = new WebVideoControlsRemoteSession();

    /** Bumped whenever DOM or engine-specific state must be re-read. */
    private readonly tick = signal(0);
    /**
     * Pull-based and sampled only while the info popover is open, so the frame
     * counters are read exactly when someone is looking at them.
     */
    readonly streamStats = new WebVideoStreamStatsSampler(
        () => this.video,
        () => this.opts.getEngineStats?.() ?? null
    );
    private readonly pictureInPicture = new WebVideoPictureInPictureController(
        () => ({
            generation: this.bindingGeneration,
            video: this.video,
        }),
        () => this.refresh()
    );
    /**
     * Holds the host-supplied series-navigation signal reactively. Storing the
     * signal itself (rather than a one-time snapshot of its value) means updates
     * the host pushes AFTER {@link setContext} are reflected here.
     */
    private readonly seriesNavigationSource = signal<
        Signal<SeriesPlaybackNavigation | null>
    >(signal(null));
    private readonly seriesNavigation = computed(() =>
        this.seriesNavigationSource()()
    );

    readonly capabilities = computed<PlayerControlsCapabilities>(() => {
        this.tick();
        const video = this.activeVideo();
        if (!video) {
            return DEFAULT_PLAYER_CAPABILITIES;
        }

        const remote = Boolean(this.remote.video());

        // Keep the audio section reachable even while the engine reports one
        // or no selectable tracks. The settings panel explains those states;
        // hiding the section made a single provider track look like a missing
        // player feature.
        const hasAudioTracks = remote
            ? this.remote.audioTracks().length > 0
            : typeof this.opts.getAudioTracks === 'function' &&
              typeof this.opts.setAudioTrack === 'function';
        const hasSubtitles =
            (remote
                ? this.remote.subtitleTracks().length
                : typeof this.opts.setSubtitleTrack === 'function'
                  ? (this.opts.getSubtitleTracks?.().length ?? 0)
                  : 0) > 0;
        // Manifest-driven: a single-rendition source advertises no selector.
        const hasQualityLevels =
            !remote &&
            typeof this.opts.setQualityLevel === 'function' &&
            (this.opts.getQualityLevels?.().length ?? 0) > 1;
        const isLive = readVideoIsLive(video, this.opts);
        const adjacentNavigation = this.seriesNavigation();
        const hasAdjacentNavigation =
            adjacentNavigation !== null &&
            (!isLive || adjacentNavigation.kind === 'channel');
        const pictureInPicture = this.pictureInPicture.snapshot();
        const recording = browserMediaLibrary.recordingSnapshot(this.video);
        return {
            ...DEFAULT_PLAYER_CAPABILITIES,
            seek: !isLive,
            volume: true,
            playbackSpeed: true,
            fullscreen: true,
            audioTracks: hasAudioTracks,
            subtitles: hasSubtitles,
            externalSubtitles:
                !remote &&
                typeof this.opts.addExternalSubtitleFile === 'function',
            subtitleDelay:
                !remote &&
                typeof this.opts.setSubtitleDelay === 'function' &&
                (this.opts.canAdjustSubtitleDelay?.() ?? true),
            subtitleStyle:
                !remote && typeof this.opts.setSubtitleStyle === 'function',
            qualityLevels: hasQualityLevels,
            aspectRatio: false,
            recording:
                !remote &&
                isLive &&
                browserMediaLibrary.recordingSupported &&
                (!recording.owner || recording.owner === this.video),
            pictureInPicture: !remote && pictureInPicture.supported,
            seriesNavigation: hasAdjacentNavigation,
            // The element always knows its own size and frame counters.
            streamStats: !remote,
        };
    });

    readonly state = computed<PlayerControlsState>(() => {
        this.tick();
        const video = this.activeVideo();
        if (!video) {
            return createEmptyControlsState();
        }

        const isLive = readVideoIsLive(video, this.opts);
        const duration = normalizeVideoDuration(
            readVideoDuration(video, this.opts),
            isLive
        );
        const seriesNav = this.seriesNavigation();
        const seriesNavCapable =
            seriesNav !== null && (!isLive || seriesNav.kind === 'channel');

        const remote = Boolean(this.remote.video());
        const audioTracks = remote
            ? this.remote.audioTracks()
            : (this.opts.getAudioTracks?.() ?? []);
        const subtitleTracks = remote
            ? this.remote.subtitleTracks()
            : (this.opts.getSubtitleTracks?.() ?? []);
        const qualityLevels = remote
            ? []
            : (this.opts.getQualityLevels?.() ?? []);
        const pictureInPicture = this.pictureInPicture.snapshot();
        const recording = browserMediaLibrary.recordingSnapshot(video);

        return {
            status: remote ? this.remote.status() : mapVideoStatus(video),
            statusMessage: '',
            stalled:
                remote ? this.remote.status() === 'loading' : isVideoStalled(video),
            positionSeconds: Math.max(0, video?.currentTime ?? 0),
            durationSeconds: duration,
            isLive,
            canSeek: !isLive && (duration ?? 0) > 0 && hasSeekableRange(video),
            volume: readVideoVolume(video),
            audioTracks,
            subtitleTracks,
            subtitlesEnabled: subtitleTracks.some((track) => track.selected),
            subtitleDelaySeconds: this.opts.getSubtitleDelay?.() ?? 0,
            subtitleStyle:
                this.opts.getSubtitleStyle?.() ?? DEFAULT_SUBTITLE_STYLE,
            qualityLevels,
            qualityAutoEnabled: remote
                ? true
                : (this.opts.isAutoQualityEnabled?.() ?? true),
            playbackSpeed: video?.playbackRate ?? 1,
            speedPresets: DEFAULT_SPEED_PRESETS,
            aspectRatio: 'no',
            aspectPresets: DEFAULT_ASPECT_PRESETS,
            recording: {
                active: recording.active,
                elapsedSeconds: recording.elapsedSeconds,
                message: recording.message,
                transitionKey: recording.transitionKey,
            },
            pictureInPictureActive: pictureInPicture.active,
            canPictureInPicture: pictureInPicture.canToggle,
            canPreviousEpisode:
                seriesNavCapable && seriesNav?.canPrevious === true,
            canNextEpisode: seriesNavCapable && seriesNav?.canNext === true,
            adjacentNavigationKind: seriesNav?.kind ?? 'episode',
        };
    });

    readonly commands: PlayerControlsCommands = {
        togglePlay: () => {
            if (this.remote.video()) this.remote.togglePlay();
            else toggleVideoPlay(this.video);
        },
        seekTo: (seconds) =>
            applyVideoCurrentTime(this.activeVideo(), seconds, () =>
                readVideoDuration(this.activeVideo(), this.opts)
            ),
        seekBy: (delta) =>
            applyVideoCurrentTime(
                this.activeVideo(),
                (this.activeVideo()?.currentTime ?? 0) + delta,
                () => readVideoDuration(this.activeVideo(), this.opts)
            ),
        setVolume: (value) => applyVideoVolume(this.activeVideo(), value),
        setAudioTrack: (id) => {
            if (this.remote.video()) this.remote.setAudioTrack(id);
            else {
                applyTrackSelection(this.opts.setAudioTrack, id, () =>
                    this.refresh()
                );
            }
        },
        setSubtitleTrack: (id) => {
            if (this.remote.video()) this.remote.setSubtitleTrack(id);
            else {
                applyTrackSelection(this.opts.setSubtitleTrack, id, () =>
                    this.refresh()
                );
            }
        },
        addExternalSubtitleFile: () => {
            try {
                // The picker refreshes through its own callback once the
                // asynchronous file read lands.
                this.opts.addExternalSubtitleFile?.();
            } catch {
                // A failed picker leaves the current tracks untouched.
            }
        },
        setSubtitleDelay: (seconds) =>
            applyTrackSelection(this.opts.setSubtitleDelay, seconds, () =>
                this.refresh()
            ),
        setSubtitleStyle: (style) =>
            applyTrackSelection(this.opts.setSubtitleStyle, style, () =>
                this.refresh()
            ),
        setQualityLevel: (id) =>
            applyTrackSelection(this.opts.setQualityLevel, id, () =>
                this.refresh()
            ),
        setPlaybackSpeed: (speed) => applyVideoSpeed(this.activeVideo(), speed),
        setAspectRatio: () => undefined,
        toggleRecording: () => {
            const video = this.video;
            if (!video || !readVideoIsLive(video, this.opts)) return;
            void browserMediaLibrary
                .toggleRecording(
                    video,
                    this.opts.getRecordingMetadata?.() ?? null
                )
                .finally(() => this.refresh());
        },
        togglePictureInPicture: () => this.pictureInPicture.toggle(),
    };

    /** Binds to a `<video>` element and starts maintaining the state signal. */
    attach(video: HTMLVideoElement, opts: WebVideoControlsOptions = {}): void {
        this.detachLocalBinding();
        const generation = this.bindingGeneration;
        this.video = video;
        this.opts = opts;
        this.streamStats.reset();
        this.unsubscribeRecording = browserMediaLibrary.subscribe((kind) => {
            if (kind === 'recordings') {
                this.syncRecordingTimer();
                this.refresh();
            }
        });

        const onEvent = () => {
            if (this.video === video && this.bindingGeneration === generation) {
                this.refresh();
            }
        };
        for (const eventName of WEB_VIDEO_EVENTS) {
            video.addEventListener(eventName, onEvent);
        }
        this.detachFn = () => {
            for (const eventName of WEB_VIDEO_EVENTS) {
                video.removeEventListener(eventName, onEvent);
            }
        };
        // Prime the initial snapshot.
        onEvent();
        this.syncRecordingTimer();
    }

    /**
     * Invalidates cached state/capabilities after an engine-specific getter
     * changes without emitting a native media event (for example tracks,
     * corrected duration, or live/VOD classification).
     */
    refresh(): void {
        this.tick.update((value) => value + 1);
    }

    /** Removes listeners and clears the bound element. Idempotent. */
    detach(): void {
        this.clearRemoteBinding();
        this.detachLocalBinding();
        this.refresh();
    }

    beginRemotePlayback(
        video: HTMLVideoElement,
        state: WebVideoRemotePlaybackResumeState
    ): void {
        if (this.remote.video() === video) return;
        this.remote.begin(video, state, () => this.refresh());
        this.opts.suspendForRemotePlayback?.();
        this.refresh();
    }

    finishRemotePlayback(
        state: WebVideoRemotePlaybackResumeState,
        restoreLocal: boolean
    ): void {
        this.clearRemoteBinding();
        if (restoreLocal) {
            if (this.opts.restoreAfterRemotePlayback) {
                this.opts.restoreAfterRemotePlayback(state);
            } else if (this.video) {
                restoreWebVideoAfterRemotePlayback(this.video, state);
            }
        }
        this.refresh();
    }

    private activeVideo(): HTMLVideoElement | null {
        return this.remote.video() ?? this.video;
    }

    private detachLocalBinding(): void {
        const previousVideo = this.video;
        if (previousVideo) {
            void browserMediaLibrary.stopRecordingFor(previousVideo);
        }
        this.bindingGeneration += 1;
        this.detachFn?.();
        this.detachFn = null;
        this.unsubscribeRecording?.();
        this.unsubscribeRecording = null;
        this.clearRecordingTimer();
        this.video = null;
        this.opts = {};
        this.streamStats.reset();
        this.pictureInPicture.release(previousVideo);
    }

    private clearRemoteBinding(): void {
        this.remote.clear();
    }

    /** Pushes reactive context (series navigation) used for capability gating. */
    setContext(context: WebVideoControlsContext): void {
        this.seriesNavigationSource.set(context.seriesNavigation);
    }

    private syncRecordingTimer(): void {
        const active = browserMediaLibrary.recordingSnapshot(this.video).active;
        if (active && this.recordingTimer === null) {
            this.recordingTimer = window.setInterval(
                () => this.refresh(),
                1000
            );
        } else if (!active) {
            this.clearRecordingTimer();
        }
    }

    private clearRecordingTimer(): void {
        if (this.recordingTimer === null) return;
        window.clearInterval(this.recordingTimer);
        this.recordingTimer = null;
    }
}
