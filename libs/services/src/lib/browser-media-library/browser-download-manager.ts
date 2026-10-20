import type {
    DownloadMetadataSnapshot,
    ElectronBridgeDownloadStartResult,
    ElectronBridgeErrorResult,
} from '@iptvnator/shared/interfaces';
import type { DownloadItem, DownloadStartInput } from '../downloads.models';
import { resolvePrivateBrowserMediaUrl } from './browser-media-capabilities';
import {
    supportsBrowserDownloadLocks,
    withBrowserDownloadLock,
} from './browser-download-lock';
import {
    createBrowserDownloadItem,
    sanitizeBrowserPersistedUrl,
} from './browser-download-item';
import {
    captureBrowserDownloadSourceId,
    sourceIdForBrowserDownloadEnqueue,
} from './browser-download-source';
import { updateBrowserDownloadMetadata } from './browser-download-metadata';
import { BrowserDownloadQueue } from './browser-download-queue';
import { redownloadMissingBrowserDownload } from './browser-download-redownload';
import {
    listSanitizedBrowserDownloads,
    recoverInterruptedBrowserDownloads,
} from './browser-download-maintenance';
import {
    BrowserDownloadPresence,
    type BrowserDownloadPresencePort,
} from './browser-download-presence';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import {
    BrowserPrivateStorage,
    privateMediaPath,
} from './browser-private-storage';

const DOWNLOAD_DIRECTORY = 'downloads';
const OWNER_LEASE_MS = 60_000;

function nextId(): number {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function nextOwnerId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `tab-${nextId()}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class BrowserDownloadManager {
    private readonly ownerId = nextOwnerId();
    private readonly queue: BrowserDownloadQueue;

    constructor(
        private readonly storage: BrowserPrivateStorage,
        private readonly supported: () => boolean,
        private readonly emitChange: () => void,
        private readonly presence: BrowserDownloadPresencePort = new BrowserDownloadPresence()
    ) {
        this.queue = new BrowserDownloadQueue(
            storage,
            this.ownerId,
            emitChange,
            presence
        );
    }

    async recoverInterrupted(): Promise<void> {
        await this.recoverExpired();
    }

    async list(): Promise<DownloadItem[]> {
        await this.recoverExpired();
        return listSanitizedBrowserDownloads(this.storage);
    }

    async start(
        input: DownloadStartInput
    ): Promise<ElectronBridgeDownloadStartResult> {
        if (!this.supported()) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.storageUnsupported,
            };
        }
        const safeUrl = sanitizeBrowserPersistedUrl(
            resolvePrivateBrowserMediaUrl(input.url) ?? undefined
        );
        if (!safeUrl) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.sourceUnsupported,
            };
        }
        if (/\.m3u8(?:$|\?)/iu.test(safeUrl)) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.hlsUnsupported,
            };
        }

        const previous = (await this.list()).find(
            (item) =>
                item.playlistId === input.playlistId &&
                item.xtreamId === input.xtreamId &&
                item.contentType === input.contentType
        );
        if (
            previous?.status === 'completed' &&
            previous.filePath &&
            previous.fileAvailability !== 'missing'
        ) {
            return {
                success: true,
                id: previous.id,
                reason: 'already-downloaded',
            };
        }
        if (
            previous?.status === 'queued' ||
            previous?.status === 'downloading'
        ) {
            return { success: true, id: previous.id };
        }
        if (
            previous &&
            ['paused', 'failed', 'canceled'].includes(previous.status)
        ) {
            const resumed = await this.resume(previous.id);
            return resumed.success
                ? { success: true, id: previous.id }
                : resumed;
        }
        if (previous) {
            const removed = await this.remove(previous.id);
            if (!removed.success) return removed;
        }

        const id = nextId();
        const extension =
            safeUrl.match(/\.([a-z0-9]{1,12})(?:$|\?)/iu)?.[1] ?? 'media';
        const fileName = `${id}.${extension}`;
        const createdAt = new Date().toISOString();
        let mediaSourceId: string;
        try {
            mediaSourceId = await captureBrowserDownloadSourceId(safeUrl);
        } catch (error) {
            return { success: false, error: errorMessage(error) };
        }
        const item = createBrowserDownloadItem(input, {
            id,
            safeUrl,
            mediaSourceId,
            fileName,
            filePath: privateMediaPath(DOWNLOAD_DIRECTORY, fileName),
            ownerId: this.ownerId,
            leaseUntil: Date.now() + OWNER_LEASE_MS,
            createdAt,
        });
        const reserved = await this.storage.putDownloadIfAbsent(item);
        if (reserved.id !== item.id) {
            return { success: true, id: reserved.id };
        }
        this.emitChange();
        this.queue.enqueue(item, 0);
        return { success: true, id };
    }

    async pause(id: number): Promise<ElectronBridgeErrorResult> {
        const item = await this.storage.getDownload(id);
        if (!item || !['queued', 'downloading'].includes(item.status)) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.downloadNotActive,
            };
        }
        item.status = 'paused';
        item.browserOwnerId = undefined;
        item.browserLeaseUntil = undefined;
        item.updatedAt = new Date().toISOString();
        await this.storage.putDownload(item);
        await this.queue.stop(id);
        this.emitChange();
        return { success: true };
    }

    async cancel(id: number): Promise<ElectronBridgeErrorResult> {
        const item = await this.storage.getDownload(id);
        if (!item) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.downloadNotFound,
            };
        }
        item.status = 'canceled';
        const foreignLeaseActive =
            !!item.browserOwnerId &&
            item.browserOwnerId !== this.ownerId &&
            (item.browserLeaseUntil ?? 0) > Date.now();
        item.browserOwnerId = undefined;
        item.browserLeaseUntil = undefined;
        item.updatedAt = new Date().toISOString();
        await this.storage.putDownload(item);
        await this.queue.stop(id);
        if (!foreignLeaseActive || supportsBrowserDownloadLocks()) {
            try {
                const removed = await withBrowserDownloadLock(id, false, () =>
                    this.storage.deleteFile(item.filePath)
                );
                if (!removed) {
                    return {
                        success: false,
                        error: BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab,
                    };
                }
            } catch (error) {
                this.emitChange();
                return { success: false, error: errorMessage(error) };
            }
        }
        this.emitChange();
        return { success: true };
    }

    async resume(id: number): Promise<ElectronBridgeErrorResult> {
        await this.recoverExpired();
        const current = await this.storage.sanitizeDownload(id);
        const currentOffset =
            current?.status === 'canceled'
                ? 0
                : (current?.bytesDownloaded ?? 0);
        let capturedSourceId: string | undefined;
        try {
            capturedSourceId =
                current &&
                ['paused', 'failed', 'canceled'].includes(current.status)
                    ? await sourceIdForBrowserDownloadEnqueue(
                          current,
                          currentOffset
                      )
                    : undefined;
        } catch (error) {
            return { success: false, error: errorMessage(error) };
        }
        const claim = await this.storage.claimDownloadForResume(
            id,
            this.ownerId,
            Date.now() + OWNER_LEASE_MS,
            new Date().toISOString(),
            capturedSourceId
        );
        if (!claim) {
            const current = await this.storage.getDownload(id);
            const activeOtherTab =
                !!current &&
                ['queued', 'downloading'].includes(current.status) &&
                !!current.browserOwnerId &&
                current.browserOwnerId !== this.ownerId;
            return {
                success: false,
                error: !current?.url
                    ? BROWSER_MEDIA_MESSAGES.sourceUnsupported
                    : activeOtherTab
                      ? BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab
                      : BROWSER_MEDIA_MESSAGES.downloadCannotResume,
            };
        }
        const lockAvailable = await withBrowserDownloadLock(
            id,
            true,
            async () => undefined
        );
        if (!lockAvailable) {
            await this.storage.restoreDownloadClaim(
                id,
                this.ownerId,
                claim.previous
            );
            this.emitChange();
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab,
            };
        }
        this.emitChange();
        this.queue.enqueue(claim.item, claim.offset, claim.previous);
        return { success: true };
    }

    async redownloadMissing(id: number): Promise<ElectronBridgeErrorResult> {
        return redownloadMissingBrowserDownload(
            this.storage,
            this.queue,
            this.ownerId,
            this.emitChange,
            id
        );
    }

    async remove(id: number): Promise<ElectronBridgeErrorResult> {
        const item = await this.storage.getDownload(id);
        const foreignLeaseActive =
            !!item &&
            ['queued', 'downloading'].includes(item.status) &&
            !!item.browserOwnerId &&
            item.browserOwnerId !== this.ownerId &&
            (item.browserLeaseUntil ?? 0) > Date.now();
        if (foreignLeaseActive && !supportsBrowserDownloadLocks()) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab,
            };
        }
        await this.queue.stop(id);
        try {
            const removed = await withBrowserDownloadLock(
                id,
                false,
                async () => {
                    if (item?.filePath)
                        await this.storage.deleteFile(item.filePath);
                    await this.storage.deleteDownload(id);
                }
            );
            if (!removed) {
                await this.storage.pauseOwnedDownloadClaim(
                    id,
                    this.ownerId,
                    BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab,
                    new Date().toISOString()
                );
                this.emitChange();
                return {
                    success: false,
                    error: BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab,
                };
            }
        } catch (error) {
            await this.storage.pauseOwnedDownloadClaim(
                id,
                this.ownerId,
                errorMessage(error),
                new Date().toISOString()
            );
            this.emitChange();
            return { success: false, error: errorMessage(error) };
        }
        this.emitChange();
        return { success: true };
    }

    async clear(playlistId?: string): Promise<ElectronBridgeErrorResult> {
        const items = await this.list();
        const clearable = items.filter(
            (item) =>
                (!playlistId || item.playlistId === playlistId) &&
                ['completed', 'failed', 'canceled'].includes(item.status)
        );
        for (const item of clearable) {
            const result = await this.remove(item.id);
            if (!result.success) return result;
        }
        return { success: true };
    }

    async updateMetadata(
        id: number,
        snapshot: DownloadMetadataSnapshot
    ): Promise<ElectronBridgeErrorResult> {
        return updateBrowserDownloadMetadata(
            this.storage,
            id,
            snapshot,
            (safeSnapshot) =>
                this.queue.updatePendingMetadata(id, safeSnapshot),
            this.emitChange
        );
    }

    private async recoverExpired(): Promise<Set<number>> {
        const recovered = new Set(
            await recoverInterruptedBrowserDownloads(
                this.storage,
                (ownerId, downloadId, now) =>
                    this.presence.ownerObservable(ownerId, downloadId, now)
            )
        );
        if (recovered.size > 0) this.emitChange();
        return recovered;
    }
}
