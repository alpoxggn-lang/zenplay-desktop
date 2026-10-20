import { computed, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type {
    DownloadMetadataSnapshot,
    DownloadRecoveryResult,
    ElectronBridgeDownloadStartResult,
} from '@iptvnator/shared/interfaces';
import { browserMediaLibrary } from './browser-media-library';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-library/browser-media-messages';
import { DownloadListLoadState } from './download-list-load-state';
import { updateDownloadMetadata } from './downloads-metadata-update';
import { DownloadsQueryBase } from './downloads-query.base';
import type { DownloadItem, DownloadStartInput } from './downloads.models';
import { tryDownloadAction } from './downloads.utils';
import { RuntimeCapabilitiesService } from './runtime-capabilities.service';

export type {
    DownloadItem,
    DownloadStartInput,
    DownloadStatus,
} from './downloads.models';

const BROWSER_DOWNLOAD_RECOVERY_POLL_MS = 15_000;

@Injectable({ providedIn: 'root' })
export class DownloadsService extends DownloadsQueryBase implements OnDestroy {
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly translate = inject(TranslateService, { optional: true });
    private readonly browserMediaAvailable = signal(true);
    private unsubscribe?: () => void;
    private browserRecoveryPoll?: number;
    private readonly downloadListLoadState = new DownloadListLoadState();

    /** Signal for the list of downloads */
    readonly downloads = signal<DownloadItem[]>([]);

    /** Whether the download list is currently being loaded */
    readonly isLoadingDownloads = this.downloadListLoadState.isLoading;

    /** Whether the first download list request has completed */
    readonly hasLoadedDownloads = this.downloadListLoadState.hasLoaded;

    /** Whether the latest download list request completed successfully */
    readonly hasAuthoritativeDownloadList =
        this.downloadListLoadState.hasAuthoritativeList;

    /** Whether downloads are available through Electron or private browser storage. */
    readonly isAvailable = computed(
        () =>
            this.runtime.supportsDownloads &&
            (!this.usesBrowserMediaLibrary || this.browserMediaAvailable())
    );

    /** Whether a completed file can be revealed in a native file manager. */
    readonly canRevealFiles = computed(
        () => this.runtime.supportsDownloadFileReveal
    );

    /** Whether there are any downloads */
    readonly hasDownloads = computed(() => this.downloads().length > 0);

    /** Active downloads count */
    readonly activeCount = computed(
        () =>
            this.downloads().filter(
                (d) => d.status === 'queued' || d.status === 'downloading'
            ).length
    );

    /** Completed downloads count */
    readonly completedCount = computed(
        () => this.downloads().filter((d) => d.status === 'completed').length
    );

    /** Failed downloads count */
    readonly failedCount = computed(
        () =>
            this.downloads().filter(
                (d) => d.status === 'failed' || d.status === 'canceled'
            ).length
    );

    /** Current download folder */
    readonly downloadFolder = signal<string>('');

    constructor() {
        super();
        void this.init();
    }

    private async init() {
        if (!this.isAvailable()) {
            return;
        }

        if (this.usesBrowserMediaLibrary) {
            try {
                this.unsubscribe = browserMediaLibrary.subscribe((kind) => {
                    if (kind === 'downloads') void this.loadDownloads();
                });
                await browserMediaLibrary.initialize();
                await this.loadDownloads();
                this.startBrowserRecoveryPolling();
                this.downloadFolder.set(
                    BROWSER_MEDIA_MESSAGES.privateStorageLabel
                );
            } catch (error) {
                this.unsubscribe?.();
                this.unsubscribe = undefined;
                this.browserMediaAvailable.set(false);
                this.downloadListLoadState.markFailed();
                console.error(
                    '[DownloadsService] Browser media initialization failed:',
                    error
                );
            }
            return;
        }

        // Subscribe BEFORE the initial load, so a transition pinged while
        // that request is pending is coalesced into a trailing refresh
        // instead of being lost with the pre-transition response.
        this.unsubscribe = window.electron.onDownloadsUpdate(() => {
            this.loadDownloads();
        });

        // Load initial download list
        await this.loadDownloads();

        // Load download folder
        await this.loadDownloadFolder();
    }

    ngOnDestroy() {
        this.unsubscribe?.();
        if (this.browserRecoveryPoll !== undefined) {
            window.clearInterval(this.browserRecoveryPoll);
        }
    }

    /**
     * Load downloads from the backend. Overlapping callers coalesce behind one
     * serialized trailing refresh.
     */
    async loadDownloads(): Promise<void> {
        if (!this.isAvailable()) return;

        return this.downloadListLoadState.run(async () => {
            try {
                const list = this.usesBrowserMediaLibrary
                    ? await browserMediaLibrary.listDownloads()
                    : await window.electron.downloadsGetList();
                this.downloads.set(list);
                this.downloadListLoadState.markSucceeded();
            } catch (error) {
                console.error(
                    '[DownloadsService] Error loading downloads:',
                    error
                );
                this.downloadListLoadState.markFailed();
            }
        });
    }

    /**
     * Load or resolve download folder
     */
    async loadDownloadFolder(): Promise<string> {
        if (!this.isAvailable()) return '';

        if (this.usesBrowserMediaLibrary) {
            const folder = BROWSER_MEDIA_MESSAGES.privateStorageLabel;
            this.downloadFolder.set(folder);
            return folder;
        }

        // The main process owns folder authorization. It returns either the OS
        // default or a custom folder previously selected through a native
        // dialog, rather than trusting renderer-managed settings.
        try {
            const defaultFolder =
                await window.electron.downloadsGetDefaultFolder();
            this.downloadFolder.set(defaultFolder);
            return defaultFolder;
        } catch (error) {
            console.error(
                '[DownloadsService] Error getting default folder:',
                error
            );
            return '';
        }
    }

    /**
     * Start a new download
     */
    async startDownload(
        data: DownloadStartInput
    ): Promise<ElectronBridgeDownloadStartResult> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Downloads not available' };
        }

        if (this.usesBrowserMediaLibrary) {
            return tryDownloadAction(
                'starting browser download',
                () => browserMediaLibrary.startDownload(data),
                (error) => ({ success: false, error })
            );
        }

        const folder = await this.loadDownloadFolder();
        if (!folder) {
            return { success: false, error: 'No download folder configured' };
        }

        return tryDownloadAction(
            'starting download',
            () =>
                window.electron.downloadsStart({
                    ...data,
                    downloadFolder: folder,
                }),
            (error) => ({ success: false, error })
        );
    }

    /**
     * Cancel a download
     */
    async cancelDownload(
        downloadId: number
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Downloads not available' };
        }

        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.cancelDownload(downloadId);
        }

        return tryDownloadAction(
            'canceling download',
            () => window.electron.downloadsCancel(downloadId),
            (error) => ({ success: false, error })
        );
    }

    /**
     * Pause a queued or active download
     */
    async pauseDownload(
        downloadId: number
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Downloads not available' };
        }
        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.pauseDownload(downloadId);
        }

        return tryDownloadAction(
            'pausing download',
            () => window.electron.downloadsPause(downloadId),
            (error) => ({ success: false, error })
        );
    }

    /**
     * Resume a paused download
     */
    async resumeDownload(
        downloadId: number
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Downloads not available' };
        }
        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.resumeDownload(downloadId);
        }

        const folder = await this.loadDownloadFolder();
        if (!folder) {
            return { success: false, error: 'No download folder configured' };
        }

        return tryDownloadAction(
            'resuming download',
            () => window.electron.downloadsResume(downloadId, folder),
            (error) => ({ success: false, error })
        );
    }

    /**
     * Retry a failed download
     */
    async retryDownload(
        downloadId: number
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Downloads not available' };
        }
        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.resumeDownload(downloadId);
        }

        const folder = await this.loadDownloadFolder();
        if (!folder) {
            return { success: false, error: 'No download folder configured' };
        }

        return tryDownloadAction(
            'retrying download',
            () => window.electron.downloadsRetry(downloadId, folder),
            (error) => ({ success: false, error })
        );
    }

    /**
     * Re-download a completed item whose finalized file is unavailable.
     */
    async redownloadMissing(
        downloadId: number
    ): Promise<{ success: boolean; recovered?: boolean; error?: string }> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Downloads not available' };
        }
        if (this.usesBrowserMediaLibrary) {
            const result =
                await browserMediaLibrary.redownloadMissing(downloadId);
            return { ...result, recovered: result.success };
        }

        return tryDownloadAction(
            're-downloading missing file',
            () => window.electron.downloadsRedownloadMissing(downloadId),
            (error) => ({ success: false, error })
        );
    }

    /**
     * Remove a download from the list
     */
    async removeDownload(downloadId: number): Promise<DownloadRecoveryResult> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Downloads not available' };
        }
        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.removeDownload(downloadId);
        }

        return tryDownloadAction(
            'removing download',
            () => window.electron.downloadsRemove(downloadId),
            (error) => ({ success: false, error })
        );
    }

    /** Update the offline metadata snapshot for a managed download. */
    async updateMetadata(
        id: number,
        snapshot: DownloadMetadataSnapshot
    ): Promise<{ success: boolean; error?: string }> {
        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.updateDownloadMetadata(id, snapshot);
        }
        return updateDownloadMetadata(this, id, snapshot);
    }

    /**
     * Play a downloaded file
     */
    async playDownload(
        filePath: string
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Downloads not available' };
        }
        if (this.usesBrowserMediaLibrary) {
            const item = this.downloads().find(
                ({ filePath: path }) => path === filePath
            );
            return browserMediaLibrary.playPrivateFile(
                filePath,
                item?.title ?? 'ZenPlay',
                this.translate?.instant('CLOSE') ?? 'CLOSE'
            );
        }

        return tryDownloadAction(
            'playing file',
            () => window.electron.downloadsPlayFile(filePath),
            (error) => ({ success: false, error })
        );
    }

    /**
     * Reveal file in system file manager
     */
    async revealFile(
        filePath: string
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Downloads not available' };
        }
        if (this.usesBrowserMediaLibrary) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.privateStorageOnly,
            };
        }

        return tryDownloadAction(
            'revealing file',
            () => window.electron.downloadsRevealFile(filePath),
            (error) => ({ success: false, error })
        );
    }

    /**
     * Select a new download folder
     */
    async selectFolder(): Promise<string | null> {
        if (!this.isAvailable()) {
            return null;
        }
        if (this.usesBrowserMediaLibrary) {
            await browserMediaLibrary.initialize();
            const folder = BROWSER_MEDIA_MESSAGES.privateStorageLabel;
            this.downloadFolder.set(folder);
            return folder;
        }

        try {
            const folder = await window.electron.downloadsSelectFolder();
            if (folder) {
                this.downloadFolder.set(folder);
            }
            return folder;
        } catch (error) {
            console.error('[DownloadsService] Error selecting folder:', error);
            return null;
        }
    }

    /**
     * Clear completed/failed downloads
     */
    async clearCompleted(playlistId?: string): Promise<DownloadRecoveryResult> {
        if (!this.isAvailable()) {
            return { success: false };
        }
        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.clearDownloads(playlistId);
        }

        return tryDownloadAction(
            'clearing completed',
            () => window.electron.downloadsClearCompleted(playlistId),
            () => ({ success: false })
        );
    }

    /** Kept defensive for prototype-only unit harnesses used by this service. */
    private get usesBrowserMediaLibrary(): boolean {
        return this.runtime?.isPwa === true;
    }

    private startBrowserRecoveryPolling(): void {
        if (this.browserRecoveryPoll !== undefined) return;
        this.browserRecoveryPoll = window.setInterval(() => {
            if (this.activeCount() > 0) void this.loadDownloads();
        }, BROWSER_DOWNLOAD_RECOVERY_POLL_MS);
    }
}
