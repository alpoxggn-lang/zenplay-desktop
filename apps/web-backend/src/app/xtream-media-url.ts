import type { MediaSession } from './media-session-store';

export type XtreamMediaKind = 'live' | 'movie' | 'series';

export function buildXtreamMediaUrl(
    session: MediaSession,
    kind: XtreamMediaKind,
    streamId: string,
    extension: string
): URL {
    const url = new URL(session.targetBaseUrl);
    const root = url.pathname.replace(/\/+$/, '');
    url.pathname = `${root}/${kind}/${encodeURIComponent(
        session.username
    )}/${encodeURIComponent(session.password)}/${streamId}.${extension}`;
    url.search = '';
    url.hash = '';
    return url;
}
