import {
    type RemotePlaybackTicketRequest,
    type RemotePlaybackTicketResponse,
    resolveRemotePlaybackTicketRevokeUrl,
    validateRemotePlaybackTicketUrl,
} from './web-video-remote-playback-source';

export interface PreparedRemotePlaybackTicket {
    readonly expiresInSeconds: number;
    readonly url: string;
}

export class RemotePlaybackTicketError extends Error {
    constructor(
        readonly status: number,
        readonly retryAfterMs: number | null
    ) {
        super('Remote playback unavailable');
        this.name = 'RemotePlaybackTicketError';
    }

    get recoverable(): boolean {
        return (
            this.status === 0 ||
            this.status === 408 ||
            this.status === 429 ||
            this.status >= 500
        );
    }
}

export async function prepareRemotePlaybackTicket(
    fetchImpl: typeof fetch,
    request: RemotePlaybackTicketRequest,
    signal: AbortSignal
): Promise<PreparedRemotePlaybackTicket> {
    const response = await fetchImpl(request.endpoint, {
        body: JSON.stringify({
            adaptive: request.adaptive,
            extension: request.extension,
            kind: request.kind,
            streamId: request.streamId,
        }),
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal,
    });
    if (!response.ok) {
        throw new RemotePlaybackTicketError(
            response.status,
            readRetryAfterMs(response.headers.get('Retry-After'))
        );
    }
    const payload = (await response.json()) as RemotePlaybackTicketResponse;
    const url = validateRemotePlaybackTicketUrl(payload.url, request.endpoint);
    if (!url) throw new Error('Invalid remote playback URL');
    const expiresInSeconds =
        typeof payload.expiresInSeconds === 'number' &&
        Number.isFinite(payload.expiresInSeconds)
            ? Math.max(30, payload.expiresInSeconds)
            : 15 * 60;
    return { expiresInSeconds, url };
}

function readRetryAfterMs(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(5 * 60_000, Math.max(1_000, seconds * 1_000));
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    return Math.min(5 * 60_000, Math.max(1_000, timestamp - Date.now()));
}

export async function revokeRemotePlaybackTicket(
    fetchImpl: typeof fetch,
    ticketUrl: string,
    endpoint: string
): Promise<void> {
    const revokeUrl = resolveRemotePlaybackTicketRevokeUrl(ticketUrl, endpoint);
    if (!revokeUrl) return;
    try {
        await fetchImpl(revokeUrl, {
            credentials: 'include',
            keepalive: true,
            method: 'DELETE',
        });
    } catch {
        // Revocation is best effort during source teardown or page shutdown.
    }
}
