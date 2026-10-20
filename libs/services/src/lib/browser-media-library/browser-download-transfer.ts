import type { DownloadItem } from '../downloads.models';
import { responseMatchesRequestedRange } from './browser-media-capabilities';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import type { BrowserPrivateStorage } from './browser-private-storage';

type DownloadChangeEmitter = () => void;
const MEDIA_SOURCE_HEADER = 'x-zenplay-media-source';
const EXPECTED_MEDIA_SOURCE_HEADER = 'x-zenplay-expected-media-source';
const OWNER_LEASE_MS = 60_000;
const OWNER_HEARTBEAT_MS = 15_000;

function transientOwnerId(): string {
    return (
        globalThis.crypto?.randomUUID?.() ??
        `browser-${Date.now()}-${Math.random()}`
    );
}

function ensureNotAborted(controller: AbortController): void {
    if (controller.signal.aborted) {
        throw new Error(BROWSER_MEDIA_MESSAGES.downloadInterrupted);
    }
}

async function ensureStillOwned(
    storage: BrowserPrivateStorage,
    item: DownloadItem,
    ownerId: string,
    controller: AbortController
): Promise<void> {
    ensureNotAborted(controller);
    const current = await storage.getDownload(item.id);
    if (
        !current ||
        current.status !== 'downloading' ||
        current.browserOwnerId !== ownerId
    ) {
        controller.abort();
        ensureNotAborted(controller);
    }
}

async function persistOwned(
    storage: BrowserPrivateStorage,
    item: DownloadItem,
    ownerId: string,
    controller: AbortController
): Promise<void> {
    ensureNotAborted(controller);
    const persisted = await storage.putDownloadIfOwned(item, ownerId);
    if (!persisted) {
        controller.abort();
        ensureNotAborted(controller);
    }
}

function responseTotalBytes(
    response: Response,
    offset: number
): number | undefined {
    const range = /\/([0-9]+)$/u.exec(
        response.headers.get('content-range') ?? ''
    );
    if (range) return Number(range[1]);
    const contentLength = Number(response.headers.get('content-length') || 0);
    return contentLength > 0 ? contentLength + offset : undefined;
}

async function closePartialWriter(
    writable: FileSystemWritableFileStream | null
): Promise<void> {
    if (!writable) return;
    try {
        await writable.close();
    } catch {
        try {
            await writable.abort();
        } catch {
            // The browser already released the temporary writer.
        }
    }
}

async function fetchDownload(
    url: string,
    offset: number,
    validator: string | undefined,
    mediaSourceId: string | undefined,
    signal: AbortSignal
): Promise<Response> {
    const headers: Record<string, string> = {};
    if (offset > 0) headers['Range'] = `bytes=${offset}-`;
    if (offset > 0 && validator) headers['If-Range'] = validator;
    if (mediaSourceId) {
        headers[EXPECTED_MEDIA_SOURCE_HEADER] = mediaSourceId;
    }
    return fetch(url, {
        credentials: 'include',
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        signal,
    });
}

function bindResponseToMediaSource(
    response: Response,
    item: DownloadItem
): void {
    if ([409, 412].includes(response.status)) {
        throw new Error(BROWSER_MEDIA_MESSAGES.sourceChanged);
    }
    const sourceId = response.headers.get(MEDIA_SOURCE_HEADER)?.trim();
    if (!sourceId) {
        throw new Error(BROWSER_MEDIA_MESSAGES.sourceUnconfirmed);
    }
    if (item.mediaSourceId && sourceId !== item.mediaSourceId) {
        throw new Error(BROWSER_MEDIA_MESSAGES.sourceChanged);
    }
    item.mediaSourceId = sourceId;
}

function responseResumeValidator(response: Response): string | undefined {
    const etag = response.headers.get('etag')?.trim();
    if (etag && !/^W\//iu.test(etag)) return etag;
    return response.headers.get('last-modified')?.trim() || undefined;
}

export async function transferBrowserDownload(
    storage: BrowserPrivateStorage,
    item: DownloadItem,
    requestedOffset: number,
    controller: AbortController,
    emitChange: DownloadChangeEmitter,
    ownerId = transientOwnerId()
): Promise<void> {
    let writable: FileSystemWritableFileStream | null = null;
    let ownerHeartbeat: ReturnType<typeof setInterval> | null = null;
    try {
        const filePath = item.filePath;
        if (!filePath) {
            throw new Error(BROWSER_MEDIA_MESSAGES.privatePathInvalid);
        }
        item.status = 'downloading';
        item.browserOwnerId = ownerId;
        item.browserLeaseUntil = Date.now() + OWNER_LEASE_MS;
        item.updatedAt = new Date().toISOString();
        if (!(await storage.claimDownload(item, ownerId))) return;
        ownerHeartbeat = setInterval(() => {
            void storage
                .refreshDownloadLease(
                    item.id,
                    ownerId,
                    Date.now() + OWNER_LEASE_MS
                )
                .then((refreshed) => {
                    if (!refreshed) controller.abort();
                })
                .catch(() => controller.abort());
        }, OWNER_HEARTBEAT_MS);
        emitChange();

        let offset = requestedOffset;
        if (offset > 0) {
            offset = (await storage.getFile(filePath))?.size ?? 0;
            item.bytesDownloaded = offset;
        }
        if (offset > 0 && !item.mediaSourceId) {
            throw new Error(BROWSER_MEDIA_MESSAGES.sourcePartialUnconfirmed);
        }
        if (offset > 0 && !item.resumeValidator) {
            offset = 0;
            item.bytesDownloaded = 0;
        }
        ensureNotAborted(controller);
        let response = await fetchDownload(
            item.url,
            offset,
            item.resumeValidator,
            item.mediaSourceId,
            controller.signal
        );
        bindResponseToMediaSource(response, item);
        const responseValidator = responseResumeValidator(response);
        const restartableRangeResponse = [200, 206, 416].includes(
            response.status
        );
        const validatorChanged =
            offset > 0 &&
            !!responseValidator &&
            responseValidator !== item.resumeValidator;
        if (
            offset > 0 &&
            restartableRangeResponse &&
            (!responseMatchesRequestedRange(response, offset) ||
                validatorChanged)
        ) {
            offset = 0;
            item.bytesDownloaded = 0;
            if (response.status !== 200 || validatorChanged) {
                await response.body?.cancel();
                response = await fetchDownload(
                    item.url,
                    0,
                    undefined,
                    item.mediaSourceId,
                    controller.signal
                );
                bindResponseToMediaSource(response, item);
            }
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!responseMatchesRequestedRange(response, offset)) {
            throw new Error(BROWSER_MEDIA_MESSAGES.invalidRange);
        }
        if (!response.body) {
            throw new Error(BROWSER_MEDIA_MESSAGES.noDownloadStream);
        }

        item.resumeValidator =
            responseResumeValidator(response) ??
            (offset > 0 ? item.resumeValidator : undefined);
        item.totalBytes = responseTotalBytes(response, offset);
        ensureNotAborted(controller);
        await persistOwned(storage, item, ownerId, controller);
        const handle = await storage.getFileHandle(filePath, true);
        writable = await handle.createWritable({
            keepExistingData: offset > 0,
        });
        if (offset > 0) await writable.seek(offset);
        else await writable.truncate(0);

        const reader = response.body.getReader();
        let downloaded = offset;
        let lastPersistedAt = 0;
        while (true) {
            ensureNotAborted(controller);
            const { value, done } = await reader.read();
            if (done) break;
            await ensureStillOwned(storage, item, ownerId, controller);
            await writable.write(value);
            ensureNotAborted(controller);
            downloaded += value.byteLength;
            item.bytesDownloaded = downloaded;
            const now = Date.now();
            if (now - lastPersistedAt >= 500) {
                lastPersistedAt = now;
                item.updatedAt = new Date(now).toISOString();
                item.browserLeaseUntil = now + OWNER_LEASE_MS;
                await persistOwned(storage, item, ownerId, controller);
                emitChange();
            }
        }
        ensureNotAborted(controller);
        if (item.totalBytes !== undefined && downloaded !== item.totalBytes) {
            throw new Error(BROWSER_MEDIA_MESSAGES.incompleteDownload);
        }
        if (downloaded === 0) {
            await writable.close();
            writable = null;
            await storage.deleteFile(filePath);
            item.fileAvailability = 'missing';
            throw new Error(BROWSER_MEDIA_MESSAGES.incompleteDownload);
        }
        await writable.truncate(downloaded);
        await writable.close();
        writable = null;
        item.bytesDownloaded = downloaded;
        item.totalBytes = item.totalBytes ?? downloaded;
        item.status = 'completed';
        item.fileAvailability = 'available';
        item.browserOwnerId = undefined;
        item.browserLeaseUntil = undefined;
        item.updatedAt = new Date().toISOString();
        await persistOwned(storage, item, ownerId, controller);
        emitChange();
    } catch (error) {
        await closePartialWriter(writable);
        if (controller.signal.aborted) return;
        try {
            const latest = await storage.getDownload(item.id);
            if (latest?.status === 'paused' || latest?.status === 'canceled') {
                return;
            }
            if (latest?.browserOwnerId !== ownerId) return;
            item.status = 'failed';
            item.errorMessage =
                error instanceof Error ? error.message : String(error);
            item.updatedAt = new Date().toISOString();
            item.browserOwnerId = undefined;
            item.browserLeaseUntil = undefined;
            await storage.putDownloadIfOwned(item, ownerId);
            emitChange();
        } catch {
            // A storage failure cannot be persisted; avoid an unhandled task.
        }
    } finally {
        if (ownerHeartbeat) clearInterval(ownerHeartbeat);
    }
}
