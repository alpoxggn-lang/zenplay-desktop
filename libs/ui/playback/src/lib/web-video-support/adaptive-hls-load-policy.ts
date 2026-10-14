import {
    type HlsConfig,
    type Level,
    type MediaPlaylist,
    type RetryConfig,
} from 'hls.js';

/** Backend preparation timeout plus a small amount of transport slack. */
export const ADAPTIVE_HLS_PREPARATION_WINDOW_MS = 125_000;

const DEFAULT_RETRY_DELAY_MS = 2_000;
const MINIMUM_RETRY_DELAY_MS = 1_000;
const MAX_RETRIES =
    Math.ceil(ADAPTIVE_HLS_PREPARATION_WINDOW_MS / MINIMUM_RETRY_DELAY_MS) + 1;
const ADAPTIVE_MASTER_PATH =
    /\/media\/adaptive\/(?:movie|series)\/\d+\.mkv\/master\.m3u8$/u;

/**
 * hls.js defaults abandon a playlist request after 20 seconds. ZenPlay's
 * adaptive endpoint can legitimately retain the first request while ffmpeg
 * prepares tracks, or answer 503 + Retry-After until they are ready.
 *
 * Return no override for every other HLS source so live/provider playback
 * keeps hls.js defaults unchanged.
 */
export function resolveAdaptiveHlsConfig(
    sourceUrl: string,
    now: () => number = Date.now
): Partial<HlsConfig> | undefined {
    if (!isAdaptiveHlsMasterUrl(sourceUrl)) return undefined;

    const deadline = now() + ADAPTIVE_HLS_PREPARATION_WINDOW_MS;
    const createRetryPolicy = (): RetryConfig => ({
        maxNumRetry: MAX_RETRIES,
        retryDelayMs: DEFAULT_RETRY_DELAY_MS,
        maxRetryDelayMs: DEFAULT_RETRY_DELAY_MS,
        backoff: 'linear',
        shouldRetry: (config, _count, isTimeout, response, retry) =>
            retry &&
            !isTimeout &&
            response?.code === 503 &&
            now() + (config?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) < deadline,
    });
    const createLoadPolicy = () => ({
        default: {
            maxTimeToFirstByteMs: ADAPTIVE_HLS_PREPARATION_WINDOW_MS,
            maxLoadTimeMs: ADAPTIVE_HLS_PREPARATION_WINDOW_MS,
            // One retained request already owns the whole preparation window.
            timeoutRetry: null,
            errorRetry: createRetryPolicy(),
        },
    });

    return {
        // FFmpeg publishes an append-only EVENT playlist while the movie is
        // being normalized. hls.js otherwise treats its newest fragment as a
        // live edge; that fragment can be ahead of the separately encoded
        // audio renditions. Start progressively at zero instead.
        startPosition: 0,
        manifestLoadPolicy: createLoadPolicy(),
        playlistLoadPolicy: createLoadPolicy(),
    };
}

export function isAdaptiveHlsMasterUrl(sourceUrl: string): boolean {
    try {
        const parsed = new URL(sourceUrl, 'https://zenplay.invalid');
        return ADAPTIVE_MASTER_PATH.test(parsed.pathname);
    } catch {
        return false;
    }
}

interface HlsDurationState {
    readonly levels: readonly Level[];
    readonly currentLevel: number;
    readonly loadLevel: number;
    readonly audioTracks: readonly MediaPlaylist[];
    readonly audioTrack: number;
}

/**
 * Ordinary media has a stable duration. The generated adaptive stream does
 * not until both its active video and audio EVENT playlists carry ENDLIST.
 */
export function isAdaptiveHlsDurationFinal(
    sourceUrl: string,
    hls: HlsDurationState | null | undefined
): boolean {
    if (!isAdaptiveHlsMasterUrl(sourceUrl)) return true;
    if (!hls) return false;

    const activeLevel =
        hls.levels[hls.currentLevel] ??
        hls.levels[hls.loadLevel] ??
        hls.levels.find((level) => level.details !== undefined);
    if (activeLevel?.details?.live !== false) return false;

    if (hls.audioTracks.length === 0) return true;
    const activeAudio =
        hls.audioTracks[hls.audioTrack] ??
        hls.audioTracks.find((track) => track.details !== undefined);
    return activeAudio?.details?.live === false;
}

/** Video.js/VHS exposes the active media playlist's ENDLIST flag directly. */
export function isAdaptiveVhsDurationFinal(
    sourceUrl: string,
    endList: boolean | undefined
): boolean {
    return !isAdaptiveHlsMasterUrl(sourceUrl) || endList === true;
}

/**
 * A saved VOD position can be ahead of the part FFmpeg has generated so far.
 * Seeking there makes an append-only EVENT source wait on a fragment that does
 * not exist yet. Keep ordinary VOD unchanged, but for our adaptive source
 * start at zero until the requested point is actually seekable. Do not clamp
 * to the current edge: copied video can be generated ahead of encoded audio.
 */
export function resolveAdaptiveProgressiveStartTime(
    sourceUrl: string,
    requestedSeconds: number,
    seekable: Pick<TimeRanges, 'end' | 'length' | 'start'>
): number {
    const requested =
        Number.isFinite(requestedSeconds) && requestedSeconds > 0
            ? requestedSeconds
            : 0;
    if (!isAdaptiveHlsMasterUrl(sourceUrl) || requested === 0) {
        return requested;
    }

    try {
        for (let index = 0; index < seekable.length; index += 1) {
            const start = seekable.start(index);
            const end = seekable.end(index);
            if (
                !Number.isFinite(start) ||
                !Number.isFinite(end) ||
                end <= start
            ) {
                continue;
            }
            if (requested >= start && requested <= end) return requested;
        }
    } catch {
        return 0;
    }
    return 0;
}
