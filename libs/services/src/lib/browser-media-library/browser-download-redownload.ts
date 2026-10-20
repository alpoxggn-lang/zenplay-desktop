import type { ElectronBridgeErrorResult } from '@iptvnator/shared/interfaces';
import { withBrowserDownloadLock } from './browser-download-lock';
import type { BrowserDownloadQueue } from './browser-download-queue';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import type { BrowserPrivateStorage } from './browser-private-storage';

const OWNER_LEASE_MS = 60_000;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function redownloadMissingBrowserDownload(
    storage: BrowserPrivateStorage,
    queue: BrowserDownloadQueue,
    ownerId: string,
    emitChange: () => void,
    id: number
): Promise<ElectronBridgeErrorResult> {
    const claim = await storage.claimDownloadForRedownload(
        id,
        ownerId,
        Date.now() + OWNER_LEASE_MS,
        new Date().toISOString()
    );
    if (!claim) {
        const current = await storage.getDownload(id);
        return {
            success: false,
            error: !current
                ? BROWSER_MEDIA_MESSAGES.downloadNotFound
                : !current.url
                  ? BROWSER_MEDIA_MESSAGES.sourceUnsupported
                  : BROWSER_MEDIA_MESSAGES.downloadAlreadyActive,
        };
    }
    if (queue.contains(id)) {
        await storage.restoreDownloadClaim(id, ownerId, claim.previous);
        return {
            success: false,
            error: BROWSER_MEDIA_MESSAGES.downloadAlreadyActive,
        };
    }
    try {
        const lockAvailable = await withBrowserDownloadLock(id, true, () =>
            storage.deleteFile(claim.item.filePath)
        );
        if (!lockAvailable) {
            await storage.restoreDownloadClaim(id, ownerId, claim.previous);
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab,
            };
        }
    } catch (error) {
        await storage.restoreDownloadClaim(id, ownerId, claim.previous);
        return { success: false, error: errorMessage(error) };
    }
    emitChange();
    queue.enqueue(claim.item, 0, claim.previous);
    return { success: true };
}
