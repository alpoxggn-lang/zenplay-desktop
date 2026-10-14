import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';

function hasHeader(
    headers: Record<string, string> | undefined,
    name: string
): boolean {
    const normalizedName = name.toLowerCase();
    return Object.keys(headers ?? {}).some(
        (key) => key.toLowerCase() === normalizedName
    );
}

/**
 * Converts the portal's dedicated Origin field into the header map libmpv
 * consumes. External MPV/VLC already perform this normalization; keeping it
 * here makes every embedded engine (native view and frame copy) behave the
 * same without duplicating header rules in three native implementations.
 */
export function normalizeEmbeddedMpvPlaybackRequest(
    playback: ResolvedPortalPlayback
): ResolvedPortalPlayback {
    const origin = playback.origin?.trim();
    if (!origin || hasHeader(playback.headers, 'origin')) {
        return playback;
    }

    return {
        ...playback,
        headers: {
            ...(playback.headers ?? {}),
            Origin: origin,
        },
    };
}
