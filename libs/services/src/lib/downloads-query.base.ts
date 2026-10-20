import type { Signal } from '@angular/core';
import type { DownloadItem } from './downloads.models';
import {
    downloadProgressPercent,
    findDownloadByContent,
    formatDownloadBytes,
    hasAvailableCompletedDownload,
} from './downloads.utils';

type ContentType = 'vod' | 'episode';
type ActionResult = Promise<{ success: boolean; error?: string }>;

export abstract class DownloadsQueryBase {
    abstract readonly downloads: Signal<DownloadItem[]>;

    abstract resumeDownload(downloadId: number): ActionResult;

    getProgressPercent(item: DownloadItem): number {
        return downloadProgressPercent(item);
    }

    getDownload(downloadId: number): DownloadItem | undefined {
        return this.downloads().find(({ id }) => id === downloadId);
    }

    getDownloadByContent(
        xtreamId: number,
        playlistId: string,
        contentType: ContentType
    ): DownloadItem | undefined {
        return findDownloadByContent(
            this.downloads(),
            xtreamId,
            playlistId,
            contentType
        );
    }

    isDownloaded(
        xtreamId: number,
        playlistId: string,
        contentType: ContentType
    ): boolean {
        return hasAvailableCompletedDownload(
            this.getDownloadByContent(xtreamId, playlistId, contentType)
        );
    }

    isDownloading(
        xtreamId: number,
        playlistId: string,
        contentType: ContentType
    ): boolean {
        const status = this.getDownloadByContent(
            xtreamId,
            playlistId,
            contentType
        )?.status;
        return ['downloading', 'queued', 'paused'].includes(status ?? '');
    }

    isPaused(
        xtreamId: number,
        playlistId: string,
        contentType: ContentType
    ): boolean {
        return (
            this.getDownloadByContent(xtreamId, playlistId, contentType)
                ?.status === 'paused'
        );
    }

    async resumeDownloadByContent(
        xtreamId: number,
        playlistId: string,
        contentType: ContentType
    ): ActionResult {
        const download = this.getDownloadByContent(
            xtreamId,
            playlistId,
            contentType
        );
        if (!download || download.status !== 'paused') {
            return { success: false, error: 'No paused download found' };
        }
        return this.resumeDownload(download.id);
    }

    getDownloadedFilePath(
        xtreamId: number,
        playlistId: string,
        contentType: ContentType
    ): string | undefined {
        const download = this.getDownloadByContent(
            xtreamId,
            playlistId,
            contentType
        );
        return hasAvailableCompletedDownload(download)
            ? download.filePath
            : undefined;
    }

    formatBytes(bytes: number): string {
        return formatDownloadBytes(bytes);
    }
}
