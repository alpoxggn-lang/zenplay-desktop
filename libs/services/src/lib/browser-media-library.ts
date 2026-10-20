import type {
    DownloadMetadataSnapshot,
    ElectronBridgeDownloadStartResult,
    ElectronBridgeErrorResult,
    RecordingProgramSnapshot,
    RecordingStartMetadata,
} from '@iptvnator/shared/interfaces';
import type { DownloadItem, DownloadStartInput } from './downloads.models';
import {
    resolvePrivateBrowserMediaUrl,
    responseMatchesRequestedRange,
    supportsBrowserLiveRecording,
    supportsBrowserPrivateMediaStorage,
} from './browser-media-library/browser-media-capabilities';
import { BrowserDownloadManager } from './browser-media-library/browser-download-manager';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-library/browser-media-messages';
import {
    BrowserMediaChangeChannel,
    type BrowserMediaLibraryKind,
} from './browser-media-library/browser-media-change-channel';
import { openBrowserPrivateMedia } from './browser-media-library/browser-private-player';
import { BrowserPrivateStorage } from './browser-media-library/browser-private-storage';
import { BrowserRecordingManager } from './browser-media-library/browser-recording-manager';
import type {
    BrowserRecordingSnapshot,
    RecordingItem,
} from './recordings.models';

export {
    resolvePrivateBrowserMediaUrl,
    responseMatchesRequestedRange,
    supportsBrowserLiveRecording,
    supportsBrowserPrivateMediaStorage,
};
export type { BrowserRecordingSnapshot };

type LibraryListener = (kind: BrowserMediaLibraryKind) => void;

/**
 * Browser media facade. Metadata lives in IndexedDB and bytes live in OPFS,
 * while Electron continues to use its native download and recording bridges.
 */
export class BrowserMediaLibrary {
    private readonly listeners = new Set<LibraryListener>();
    private readonly changes = new BrowserMediaChangeChannel((kind) =>
        this.notify(kind)
    );
    private readonly storage = new BrowserPrivateStorage();
    private readonly downloads = new BrowserDownloadManager(
        this.storage,
        () => this.downloadsSupported,
        () => this.emit('downloads')
    );
    private readonly recordings = new BrowserRecordingManager(
        this.storage,
        () => this.recordingSupported,
        () => this.emit('recordings')
    );
    private initializePromise: Promise<void> | null = null;

    get downloadsSupported(): boolean {
        return supportsBrowserPrivateMediaStorage();
    }

    get recordingSupported(): boolean {
        return supportsBrowserLiveRecording();
    }

    subscribe(listener: LibraryListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async initialize(): Promise<void> {
        if (!this.downloadsSupported) return;
        const attempt = this.initializePromise ?? this.initializeOnce();
        this.initializePromise = attempt;
        try {
            await attempt;
        } catch (error) {
            if (this.initializePromise === attempt) {
                this.initializePromise = null;
            }
            throw error;
        }
    }

    async listDownloads(): Promise<DownloadItem[]> {
        return this.downloadsSupported ? this.downloads.list() : [];
    }

    startDownload(
        input: DownloadStartInput
    ): Promise<ElectronBridgeDownloadStartResult> {
        return this.downloads.start(input);
    }

    pauseDownload(id: number): Promise<ElectronBridgeErrorResult> {
        return this.downloads.pause(id);
    }

    cancelDownload(id: number): Promise<ElectronBridgeErrorResult> {
        return this.downloads.cancel(id);
    }

    resumeDownload(id: number): Promise<ElectronBridgeErrorResult> {
        return this.downloads.resume(id);
    }

    redownloadMissing(id: number): Promise<ElectronBridgeErrorResult> {
        return this.downloads.redownloadMissing(id);
    }

    removeDownload(id: number): Promise<ElectronBridgeErrorResult> {
        return this.downloads.remove(id);
    }

    clearDownloads(playlistId?: string): Promise<ElectronBridgeErrorResult> {
        return this.downloads.clear(playlistId);
    }

    updateDownloadMetadata(
        id: number,
        snapshot: DownloadMetadataSnapshot
    ): Promise<ElectronBridgeErrorResult> {
        return this.downloads.updateMetadata(id, snapshot);
    }

    async listRecordings(): Promise<RecordingItem[]> {
        return this.downloadsSupported ? this.recordings.list() : [];
    }

    getRecording(id: number): Promise<RecordingItem | null> {
        return this.recordings.get(id);
    }

    recordingSnapshot(
        video?: HTMLVideoElement | null
    ): BrowserRecordingSnapshot {
        return this.recordings.snapshot(video);
    }

    toggleRecording(
        video: HTMLVideoElement,
        metadata: RecordingStartMetadata | null
    ): Promise<ElectronBridgeErrorResult> {
        return this.recordings.toggle(video, metadata);
    }

    stopRecording(id: number): Promise<ElectronBridgeErrorResult> {
        return this.recordings.stop(id);
    }

    stopRecordingFor(
        video: HTMLVideoElement
    ): Promise<ElectronBridgeErrorResult> {
        return this.recordings.stopFor(video);
    }

    removeRecording(id: number): Promise<ElectronBridgeErrorResult> {
        return this.recordings.remove(id);
    }

    updateRecordingPrograms(
        filePath: string,
        programs: RecordingProgramSnapshot[]
    ): Promise<ElectronBridgeErrorResult> {
        return this.recordings.updatePrograms(filePath, programs);
    }

    async playPrivateFile(
        filePath: string,
        title: string,
        closeLabel: string
    ): Promise<ElectronBridgeErrorResult> {
        try {
            const file = await this.storage.getFile(filePath);
            if (!file)
                return {
                    success: false,
                    error: BROWSER_MEDIA_MESSAGES.fileNotFound,
                };
            openBrowserPrivateMedia(file, title, closeLabel);
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async privateFileExists(filePath: string): Promise<boolean> {
        return (await this.storage.getFile(filePath)) !== null;
    }

    private async initializeOnce(): Promise<void> {
        await this.storage.requestPersistence();
        await Promise.all([
            this.downloads.recoverInterrupted(),
            this.recordings.recoverInterrupted(),
        ]);
    }

    private emit(kind: BrowserMediaLibraryKind): void {
        this.notify(kind);
        this.changes.publish(kind);
    }

    private notify(kind: BrowserMediaLibraryKind): void {
        for (const listener of this.listeners) listener(kind);
    }
}

export const browserMediaLibrary = new BrowserMediaLibrary();
