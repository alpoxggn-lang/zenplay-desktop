import type {
    CatchupDownloadMetadata,
    DownloadContentType,
    DownloadMetadataSnapshot,
    ElectronBridgeDownloadStatus,
    ElectronBridgeDownloadStartPayload,
    ElectronDownloadFileAvailability,
} from '@iptvnator/shared/interfaces';

export type DownloadStatus = ElectronBridgeDownloadStatus;

export type DownloadStartInput = Omit<
    ElectronBridgeDownloadStartPayload,
    'downloadFolder'
>;

export interface DownloadItem {
    id: number;
    playlistId: string;
    xtreamId: number;
    contentType: DownloadContentType;
    catchup?: CatchupDownloadMetadata | null;
    seriesXtreamId?: number;
    seasonNumber?: number;
    episodeNumber?: number;
    episodeIdentityScope?:
        ElectronBridgeDownloadStartPayload['episodeIdentityScope'] | null;
    title: string;
    url: string;
    fileName?: string;
    filePath?: string;
    fileAvailability?: ElectronDownloadFileAvailability;
    posterUrl?: string;
    metadataSnapshot?: DownloadMetadataSnapshot;
    status: DownloadStatus;
    bytesDownloaded?: number;
    totalBytes?: number;
    /** Browser-only strong ETag or Last-Modified used with Range/If-Range. */
    resumeValidator?: string;
    /** Opaque backend identity that binds browser bytes to their Xtream source. */
    mediaSourceId?: string;
    /** Browser tab ownership lease used to prevent cross-tab write races. */
    browserOwnerId?: string;
    browserLeaseUntil?: number;
    errorMessage?: string;
    createdAt?: string;
    updatedAt?: string;
}
