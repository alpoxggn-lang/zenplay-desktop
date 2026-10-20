export interface RemotePlaybackTicketRequest {
    readonly adaptive: boolean;
    readonly endpoint: string;
    readonly extension: string;
    readonly kind: 'live' | 'movie' | 'series';
    readonly streamId: string;
}

export interface RemotePlaybackTicketResponse {
    readonly expiresInSeconds?: unknown;
    readonly url?: unknown;
}

const DIRECT_MEDIA_PATH =
    /^(.*\/media)\/(live|movie|series)\/(\d+)\.([a-z0-9]+)\/?$/i;
const ADAPTIVE_MEDIA_PATH =
    /^(.*\/media)\/adaptive\/(movie|series)\/(\d+)\.(mkv)\/(?:master|video|audio-\d+|subtitle-\d+)\.m3u8$/i;
const REMOTE_PLAYBACK_TICKET_PATH =
    /^(.*\/media\/cast)\/([A-Za-z0-9_-]{24,128})\/(?:stream\.[a-z0-9]+|adaptive\/master\.m3u8)$/i;

/**
 * Accept only ZenPlay's opaque browser media paths. Blob/currentSrc and
 * direct provider URLs are deliberately rejected because a receiver cannot
 * use browser cookies and must never learn provider credentials.
 */
export function resolveRemotePlaybackTicketRequest(
    sourceUrl: string,
    baseUrl: string
): RemotePlaybackTicketRequest | null {
    let source: URL;
    let page: URL;
    try {
        source = new URL(sourceUrl, baseUrl);
        page = new URL(baseUrl);
    } catch {
        return null;
    }
    if (
        !/^https?:$/.test(source.protocol) ||
        source.origin !== page.origin ||
        source.username ||
        source.password
    ) {
        return null;
    }
    const adaptive = ADAPTIVE_MEDIA_PATH.exec(source.pathname);
    const direct = DIRECT_MEDIA_PATH.exec(source.pathname);
    const match = adaptive ?? direct;
    if (!match) return null;
    const [, mediaBase, kind, streamId, extension] = match;
    return {
        adaptive: Boolean(adaptive),
        endpoint: new URL(`${mediaBase}/cast`, source.origin).href,
        extension: extension.toLowerCase(),
        kind: kind.toLowerCase() as RemotePlaybackTicketRequest['kind'],
        streamId,
    };
}

export function validateRemotePlaybackTicketUrl(
    value: unknown,
    endpoint: string
): string | null {
    if (typeof value !== 'string') return null;
    try {
        const ticket = new URL(value, endpoint);
        const issuer = new URL(endpoint);
        if (
            ticket.origin !== issuer.origin ||
            !/^https?:$/.test(ticket.protocol) ||
            ticket.username ||
            ticket.password ||
            !REMOTE_PLAYBACK_TICKET_PATH.test(ticket.pathname)
        ) {
            return null;
        }
        return ticket.href;
    } catch {
        return null;
    }
}

export function resolveRemotePlaybackTicketRevokeUrl(
    ticketUrl: string,
    endpoint: string
): string | null {
    const validated = validateRemotePlaybackTicketUrl(ticketUrl, endpoint);
    if (!validated) return null;
    const ticket = new URL(validated);
    const match = REMOTE_PLAYBACK_TICKET_PATH.exec(ticket.pathname);
    if (!match) return null;
    return new URL(`${match[1]}/${match[2]}`, ticket.origin).href;
}
