import type { HlsConfig, LoaderResponse, RetryConfig } from 'hls.js';
import {
    ADAPTIVE_HLS_PREPARATION_WINDOW_MS,
    isAdaptiveHlsDurationFinal,
    isAdaptiveHlsMasterUrl,
    isAdaptiveVhsDurationFinal,
    resolveAdaptiveProgressiveStartTime,
    resolveAdaptiveHlsConfig,
} from './adaptive-hls-load-policy';

describe('adaptive HLS load policy', () => {
    const adaptiveUrl =
        '/api/media/adaptive/series/910850.mkv/master.m3u8?session=opaque';

    it.each([
        adaptiveUrl,
        'https://zenplay.example/media/adaptive/movie/42.mkv/master.m3u8',
    ])('recognizes the generated adaptive master: %s', (url) => {
        expect(isAdaptiveHlsMasterUrl(url)).toBe(true);
    });

    it.each([
        'https://provider.example/live/master.m3u8',
        '/api/media/series/910850.mkv',
        '/api/media/adaptive/series/not-a-number.mkv/master.m3u8',
        '/api/media/adaptive/series/910850.mkv/video.m3u8',
    ])('leaves ordinary or malformed sources unchanged: %s', (url) => {
        expect(resolveAdaptiveHlsConfig(url)).toBeUndefined();
    });

    it('allows one retained manifest request for the preparation window', () => {
        const config = requireAdaptiveConfig(adaptiveUrl, () => 10_000);

        expect(config.startPosition).toBe(0);
        expect(config.manifestLoadPolicy?.default).toEqual(
            expect.objectContaining({
                maxTimeToFirstByteMs: ADAPTIVE_HLS_PREPARATION_WINDOW_MS,
                maxLoadTimeMs: ADAPTIVE_HLS_PREPARATION_WINDOW_MS,
                timeoutRetry: null,
            })
        );
        expect(config.playlistLoadPolicy?.default).toEqual(
            expect.objectContaining({
                maxTimeToFirstByteMs: ADAPTIVE_HLS_PREPARATION_WINDOW_MS,
                maxLoadTimeMs: ADAPTIVE_HLS_PREPARATION_WINDOW_MS,
                timeoutRetry: null,
            })
        );
    });

    it('retries only preparation 503 responses and stops at the shared deadline', () => {
        let timestamp = 1_000;
        const config = requireAdaptiveConfig(adaptiveUrl, () => timestamp);
        const retry = requireRetry(config);

        expect(shouldRetry(retry, 503)).toBe(true);
        expect(shouldRetry(retry, 502)).toBe(false);
        expect(shouldRetry(retry, 401)).toBe(false);
        expect(shouldRetry(retry, 503, true)).toBe(false);

        timestamp += ADAPTIVE_HLS_PREPARATION_WINDOW_MS - retry.retryDelayMs;
        expect(shouldRetry(retry, 503)).toBe(false);
    });

    it('uses the backend Retry-After cadence without exponential backoff', () => {
        const retry = requireRetry(
            requireAdaptiveConfig(adaptiveUrl, () => 10_000)
        );

        expect(retry).toEqual(
            expect.objectContaining({
                retryDelayMs: 2_000,
                maxRetryDelayMs: 2_000,
                backoff: 'linear',
            })
        );
    });

    it('keeps adaptive resume inside the part generated so far', () => {
        const generated = timeRanges([[0, 300]]);

        expect(
            resolveAdaptiveProgressiveStartTime(adaptiveUrl, 1_025, generated)
        ).toBe(0);
        expect(
            resolveAdaptiveProgressiveStartTime(adaptiveUrl, 120, generated)
        ).toBe(120);
        expect(
            resolveAdaptiveProgressiveStartTime(
                adaptiveUrl,
                1_025,
                timeRanges([])
            )
        ).toBe(0);
    });

    it('does not clamp ordinary VOD resume positions', () => {
        expect(
            resolveAdaptiveProgressiveStartTime(
                'https://provider.example/movie.mp4',
                1_025,
                timeRanges([[0, 300]])
            )
        ).toBe(1_025);
    });

    it('does not finalize a generated duration until video and audio have ENDLIST', () => {
        expect(isAdaptiveHlsDurationFinal(adaptiveUrl, null)).toBe(false);
        expect(
            isAdaptiveHlsDurationFinal(
                adaptiveUrl,
                hlsDurationState(true, true)
            )
        ).toBe(false);
        expect(
            isAdaptiveHlsDurationFinal(
                adaptiveUrl,
                hlsDurationState(false, true)
            )
        ).toBe(false);
        expect(
            isAdaptiveHlsDurationFinal(
                adaptiveUrl,
                hlsDurationState(false, false)
            )
        ).toBe(true);
    });

    it('uses VHS ENDLIST only for generated adaptive media', () => {
        expect(isAdaptiveVhsDurationFinal(adaptiveUrl, undefined)).toBe(false);
        expect(isAdaptiveVhsDurationFinal(adaptiveUrl, false)).toBe(false);
        expect(isAdaptiveVhsDurationFinal(adaptiveUrl, true)).toBe(true);
        expect(
            isAdaptiveVhsDurationFinal(
                'https://provider.example/movie.mp4',
                undefined
            )
        ).toBe(true);
    });
});

function hlsDurationState(videoLive: boolean, audioLive: boolean) {
    return {
        levels: [{ details: { live: videoLive } }],
        currentLevel: 0,
        loadLevel: 0,
        audioTracks: [{ details: { live: audioLive } }],
        audioTrack: 0,
    } as unknown as Parameters<typeof isAdaptiveHlsDurationFinal>[1];
}

function timeRanges(
    ranges: readonly (readonly [number, number])[]
): TimeRanges {
    return {
        length: ranges.length,
        start: (index) => ranges[index][0],
        end: (index) => ranges[index][1],
    };
}

function requireAdaptiveConfig(
    url: string,
    now: () => number
): Partial<HlsConfig> {
    const config = resolveAdaptiveHlsConfig(url, now);
    if (!config) throw new Error('Expected adaptive HLS config');
    return config;
}

function requireRetry(config: Partial<HlsConfig>): RetryConfig {
    const retry = config.manifestLoadPolicy?.default.errorRetry;
    if (!retry?.shouldRetry) throw new Error('Expected adaptive retry policy');
    return retry;
}

function shouldRetry(
    retry: RetryConfig,
    status: number,
    timeout = false
): boolean {
    return (
        retry.shouldRetry?.(
            retry,
            0,
            timeout,
            { code: status } as LoaderResponse,
            true
        ) ?? false
    );
}
