import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';

export interface XtreamWebPlaybackUrl {
    readonly streamUrl: string;
    readonly webDirectFallbackUrl?: string;
}

export function withXtreamAdaptiveWebPlayback(
    playback: ResolvedPortalPlayback
): ResolvedPortalPlayback {
    if (playback.webDirectFallbackUrl) return playback;
    const resolved = resolveXtreamWebPlaybackUrl(playback.streamUrl);
    return resolved.webDirectFallbackUrl
        ? { ...playback, ...resolved }
        : playback;
}

export function withXtreamDirectWebPlayback(
    playback: ResolvedPortalPlayback
): ResolvedPortalPlayback {
    return playback.webDirectFallbackUrl
        ? {
              ...playback,
              streamUrl: playback.webDirectFallbackUrl,
              webDirectFallbackUrl: undefined,
          }
        : playback;
}

const PWA_MKV_MEDIA_URL = /^(.*\/media)\/(movie|series)\/(\d+)\.mkv$/i;

/**
 * Browser engines do not expose embedded Matroska audio/subtitle tracks.
 * Route only PWA MKV playback through the backend's authenticated HLS
 * normalizer; downloads and copied source URLs keep using the direct route.
 */
export function resolveXtreamWebPlaybackUrl(
    directUrl: string
): XtreamWebPlaybackUrl {
    const match = PWA_MKV_MEDIA_URL.exec(directUrl);
    if (!match) return { streamUrl: directUrl };

    const [, mediaBase, kind, streamId] = match;
    return {
        streamUrl: `${mediaBase}/adaptive/${kind.toLowerCase()}/${streamId}.mkv/master.m3u8`,
        webDirectFallbackUrl: directUrl,
    };
}
