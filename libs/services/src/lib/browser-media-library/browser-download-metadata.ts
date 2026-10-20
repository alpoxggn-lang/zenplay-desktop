import type { DownloadMetadataSnapshot } from '@iptvnator/shared/interfaces';
import type { ElectronBridgeErrorResult } from '@iptvnator/shared/interfaces';
import {
    sanitizeBrowserDownloadMetadata,
    sanitizeBrowserPersistedUrl,
} from './browser-download-item';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import type { BrowserPrivateStorage } from './browser-private-storage';

export async function updateBrowserDownloadMetadata(
    storage: BrowserPrivateStorage,
    id: number,
    snapshot: DownloadMetadataSnapshot,
    updatePending: (snapshot: DownloadMetadataSnapshot) => void,
    emitChange: () => void
): Promise<ElectronBridgeErrorResult> {
    const item = await storage.getDownload(id);
    if (!item) {
        return {
            success: false,
            error: BROWSER_MEDIA_MESSAGES.downloadNotFound,
        };
    }
    const safeSnapshot = sanitizeBrowserDownloadMetadata(snapshot);
    if (!safeSnapshot) {
        return {
            success: false,
            error: BROWSER_MEDIA_MESSAGES.downloadNotFound,
        };
    }
    item.metadataSnapshot = safeSnapshot;
    item.posterUrl = sanitizeBrowserPersistedUrl(item.posterUrl);
    item.updatedAt = new Date().toISOString();
    const updated = await storage.updateDownloadMetadata(
        id,
        item.posterUrl,
        safeSnapshot,
        item.updatedAt
    );
    if (!updated) {
        return {
            success: false,
            error: BROWSER_MEDIA_MESSAGES.downloadNotFound,
        };
    }
    updatePending(safeSnapshot);
    emitChange();
    return { success: true };
}
