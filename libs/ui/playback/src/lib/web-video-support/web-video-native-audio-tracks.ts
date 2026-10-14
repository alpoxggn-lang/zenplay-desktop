import type { PlayerTrack } from '../player-controls/player-controls.model';
import { findPreferredSpanishAudioTrackIndex } from './preferred-audio-track';

const NATIVE_AUDIO_TRACK_EVENTS = [
    'addtrack',
    'removetrack',
    'change',
] as const;

interface NativeAudioTrack {
    readonly id?: string;
    readonly kind?: string;
    readonly label?: string;
    readonly language?: string;
    enabled: boolean;
}

interface NativeAudioTrackList {
    readonly length: number;
    readonly [index: number]: NativeAudioTrack | undefined;
    addEventListener?: (type: string, listener: EventListener) => void;
    removeEventListener?: (type: string, listener: EventListener) => void;
}

type VideoWithAudioTracks = HTMLVideoElement & {
    readonly audioTracks?: NativeAudioTrackList;
};

interface NativeAudioTrackEntry {
    readonly id: number;
    readonly track: NativeAudioTrack;
}

export interface WebVideoNativeAudioTracksConfig {
    readonly video: HTMLVideoElement;
    readonly refresh: () => void;
}

/**
 * Feature-detected bridge for WebKit's `HTMLMediaElement.audioTracks` API.
 * Chromium usually omits this API for progressive files, so unsupported
 * browsers simply expose no selectable tracks instead of failing playback.
 */
export class WebVideoNativeAudioTracks {
    private trackList: NativeAudioTrackList | null = null;
    private active = false;
    private trackIds = new WeakMap<object, number>();
    private nextTrackId = 0;
    private manualSelection = false;
    private preferredSelectionApplied = false;

    private readonly handleTrackListEvent: EventListener = () => {
        this.applyPreferredSpanishTrack();
        this.config.refresh();
    };

    private readonly handleLoadedMetadata: EventListener = () => {
        this.bindCurrentTrackList();
        this.applyPreferredSpanishTrack();
        this.config.refresh();
    };

    constructor(private readonly config: WebVideoNativeAudioTracksConfig) {}

    bind(): void {
        this.clear();
        this.active = true;
        if (typeof this.config.video.addEventListener === 'function') {
            this.config.video.addEventListener(
                'loadedmetadata',
                this.handleLoadedMetadata
            );
        }
        this.bindCurrentTrackList();
        this.applyPreferredSpanishTrack();
    }

    clear(): void {
        this.detachTrackList();
        if (typeof this.config.video.removeEventListener === 'function') {
            this.config.video.removeEventListener(
                'loadedmetadata',
                this.handleLoadedMetadata
            );
        }
        this.active = false;
        this.trackIds = new WeakMap<object, number>();
        this.nextTrackId = 0;
        this.manualSelection = false;
        this.preferredSelectionApplied = false;
    }

    getAudioTracks(): PlayerTrack[] {
        return this.readTracks().map(({ id, track }) => ({
            id,
            label:
                track.label || track.language || track.id || `Audio ${id + 1}`,
            selected: track.enabled === true,
        }));
    }

    setAudioTrack(id: number): void {
        if (!Number.isInteger(id)) {
            return;
        }

        const tracks = this.readTracks();
        if (!tracks.some((entry) => entry.id === id)) {
            return;
        }

        // Set this before mutating WebKit's list: it may dispatch `change`
        // synchronously, and a manual choice must always beat the preference.
        this.manualSelection = true;
        for (const entry of tracks) {
            entry.track.enabled = entry.id === id;
        }
        this.config.refresh();
    }

    private bindCurrentTrackList(): void {
        const trackList = this.readTrackList();
        if (trackList === this.trackList) {
            return;
        }

        this.detachTrackList();
        this.trackList = trackList;
        if (typeof trackList?.addEventListener !== 'function') {
            return;
        }
        for (const event of NATIVE_AUDIO_TRACK_EVENTS) {
            trackList.addEventListener(event, this.handleTrackListEvent);
        }
    }

    private detachTrackList(): void {
        const trackList = this.trackList;
        this.trackList = null;
        if (typeof trackList?.removeEventListener !== 'function') {
            return;
        }
        for (const event of NATIVE_AUDIO_TRACK_EVENTS) {
            trackList.removeEventListener(event, this.handleTrackListEvent);
        }
    }

    private readTrackList(): NativeAudioTrackList | null {
        if (!this.active) {
            return null;
        }
        try {
            return (
                (this.config.video as VideoWithAudioTracks).audioTracks ?? null
            );
        } catch {
            return null;
        }
    }

    private readTracks(): NativeAudioTrackEntry[] {
        if (!this.active) {
            return [];
        }

        const trackList = this.readTrackList();
        if (!trackList) {
            return [];
        }

        const result: NativeAudioTrackEntry[] = [];
        try {
            for (let index = 0; index < trackList.length; index += 1) {
                const track = trackList[index];
                if (!track || typeof track !== 'object') {
                    continue;
                }
                let id = this.trackIds.get(track);
                if (id === undefined) {
                    id = this.nextTrackId;
                    this.nextTrackId += 1;
                    this.trackIds.set(track, id);
                }
                result.push({ id, track });
            }
        } catch {
            return [];
        }
        return result;
    }

    private applyPreferredSpanishTrack(): void {
        if (
            this.manualSelection ||
            this.preferredSelectionApplied ||
            !this.active
        ) {
            return;
        }

        const entries = this.readTracks();
        const preferredIndex = findPreferredSpanishAudioTrackIndex(
            entries.map(({ track }) => track)
        );
        if (preferredIndex < 0) {
            // Tracks can arrive one at a time; keep waiting until this source
            // actually exposes a Spanish option rather than locking in early.
            return;
        }

        this.preferredSelectionApplied = true;
        for (let index = 0; index < entries.length; index += 1) {
            entries[index].track.enabled = index === preferredIndex;
        }
    }
}
