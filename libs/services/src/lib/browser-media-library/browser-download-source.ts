import type { DownloadItem } from '../downloads.models';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';

export const MEDIA_SOURCE_HEADER = 'x-zenplay-media-source';
export const EXPECTED_MEDIA_SOURCE_HEADER = 'x-zenplay-expected-media-source';

const MEDIA_SOURCE_ID = /^[a-z0-9_-]{1,256}$/iu;
const DOWNLOAD_MEDIA_PATH =
    /^(.*\/media)\/(?:movie|series)\/\d{1,16}\.[a-z0-9]{1,12}$/iu;

export function sanitizeBrowserMediaSourceId(
    value: unknown
): string | undefined {
    const candidate = typeof value === 'string' ? value.trim() : '';
    return candidate && MEDIA_SOURCE_ID.test(candidate) ? candidate : undefined;
}

export function assertBrowserDownloadResponseSource(
    response: Pick<Response, 'headers' | 'status'>,
    expectedSourceId: string
): string {
    if ([409, 412].includes(response.status)) {
        throw new Error(BROWSER_MEDIA_MESSAGES.sourceChanged);
    }
    const sourceId = sanitizeBrowserMediaSourceId(
        response.headers.get(MEDIA_SOURCE_HEADER)
    );
    if (!sourceId) {
        throw new Error(BROWSER_MEDIA_MESSAGES.sourceUnconfirmed);
    }
    if (sourceId !== expectedSourceId) {
        throw new Error(BROWSER_MEDIA_MESSAGES.sourceChanged);
    }
    return sourceId;
}

/** Captures the active opaque media-session identity before a transfer queues. */
export async function captureBrowserDownloadSourceId(
    mediaUrl: string
): Promise<string> {
    const match = DOWNLOAD_MEDIA_PATH.exec(mediaUrl);
    if (!match) {
        throw new Error(BROWSER_MEDIA_MESSAGES.sourceUnconfirmed);
    }
    const response = await fetch(`${match[1]}/source`, {
        credentials: 'include',
    });
    const sourceId = sanitizeBrowserMediaSourceId(
        response.headers.get(MEDIA_SOURCE_HEADER)
    );
    if (!sourceId) {
        throw new Error(BROWSER_MEDIA_MESSAGES.sourceUnconfirmed);
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return sourceId;
}

export async function sourceIdForBrowserDownloadEnqueue(
    item: Pick<DownloadItem, 'mediaSourceId' | 'url'>,
    offset: number
): Promise<string | undefined> {
    const existing = sanitizeBrowserMediaSourceId(item.mediaSourceId);
    if (existing || offset > 0 || !item.url) return existing;
    return captureBrowserDownloadSourceId(item.url);
}
