import type { DownloadItem } from '../downloads.models';
import {
    supportsBrowserDownloadLocks,
    withBrowserDownloadLock,
} from './browser-download-lock';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import type { BrowserPrivateStorage } from './browser-private-storage';

export async function recoverInterruptedBrowserDownloads(
    storage: BrowserPrivateStorage,
    ownerObservable: (
        ownerId: string,
        downloadId: number,
        now: number
    ) => Promise<boolean> = async () => false
): Promise<number[]> {
    const recovered: number[] = [];
    const now = Date.now();
    for (const item of await storage.listDownloads()) {
        if (!['queued', 'downloading'].includes(item.status)) continue;
        const hasLiveOwner =
            !!item.browserOwnerId && (item.browserLeaseUntil ?? 0) > now;
        if (hasLiveOwner) continue;
        if (
            !supportsBrowserDownloadLocks() &&
            item.browserOwnerId &&
            !item.browserLeaseUntil
        ) {
            continue;
        }
        if (
            item.browserOwnerId &&
            (await ownerObservable(item.browserOwnerId, item.id, now))
        ) {
            continue;
        }
        await withBrowserDownloadLock(item.id, true, async () => {
            const changed = await storage.recoverExpiredDownload(
                item.id,
                item.browserOwnerId,
                item.browserLeaseUntil,
                now,
                BROWSER_MEDIA_MESSAGES.downloadRecoveredPaused,
                new Date().toISOString()
            );
            if (changed) recovered.push(item.id);
        });
    }
    return recovered;
}

export async function listSanitizedBrowserDownloads(
    storage: BrowserPrivateStorage
): Promise<DownloadItem[]> {
    const items = await storage.listDownloads();
    const sanitized = await Promise.all(
        items.map((item) => sanitizeAndProbe(storage, item.id))
    );
    return sanitized.filter((item): item is DownloadItem => !!item);
}

async function sanitizeAndProbe(
    storage: BrowserPrivateStorage,
    id: number
): Promise<DownloadItem | undefined> {
    const item = await storage.sanitizeDownload(id);
    if (!item || item.status !== 'completed' || !item.filePath) return item;
    const availability = (await storage.getFile(item.filePath))
        ? 'available'
        : 'missing';
    if (item.fileAvailability === availability) return item;
    const expected = { ...item };
    item.fileAvailability = availability;
    item.updatedAt = new Date().toISOString();
    await storage.updateDownloadAvailability(
        expected,
        availability,
        item.updatedAt
    );
    return item;
}
