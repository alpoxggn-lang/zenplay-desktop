import type { DownloadItem } from './downloads.models';

export function formatDownloadBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const kilobyte = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const index = Math.floor(Math.log(bytes) / Math.log(kilobyte));
    return (
        parseFloat((bytes / Math.pow(kilobyte, index)).toFixed(1)) +
        ' ' +
        sizes[index]
    );
}

export function downloadProgressPercent(item: DownloadItem): number {
    if (!item.totalBytes) return 0;
    return Math.round(((item.bytesDownloaded || 0) / item.totalBytes) * 100);
}

export function findDownloadByContent(
    items: DownloadItem[],
    xtreamId: number,
    playlistId: string,
    contentType: 'vod' | 'episode'
): DownloadItem | undefined {
    return items.find(
        (item) =>
            item.xtreamId === xtreamId &&
            item.playlistId === playlistId &&
            item.contentType === contentType
    );
}

export function hasAvailableCompletedDownload(
    item: DownloadItem | undefined
): item is DownloadItem & { filePath: string } {
    return (
        item?.status === 'completed' &&
        !!item.filePath &&
        item.fileAvailability !== 'missing'
    );
}

export async function tryDownloadAction<T>(
    operation: string,
    action: () => Promise<T>,
    fallback: (message: string) => T
): Promise<T> {
    try {
        return await action();
    } catch (error) {
        console.error(`[DownloadsService] Error ${operation}:`, error);
        return fallback(error instanceof Error ? error.message : String(error));
    }
}
