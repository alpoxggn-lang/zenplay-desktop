import type { DownloadMetadataSnapshot } from '@iptvnator/shared/interfaces';
import type { DownloadItem } from '../downloads.models';
import type {
    RecordingItem,
    RecordingProgramSnapshot,
} from '../recordings.models';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import {
    BrowserDownloadStore,
    type BrowserDownloadRedownloadClaim,
    type BrowserDownloadResumeClaim,
} from './browser-download-store';
import {
    BrowserRecordingStore,
    type RecordingRemovalClaim,
} from './browser-recording-store';

const DATABASE_NAME = 'zenplay-browser-media-v1';
const DATABASE_VERSION = 1;
const DOWNLOAD_STORE = 'downloads';
const RECORDING_STORE = 'recordings';
const OPFS_ROOT = 'zenplay-private-media';
const OPFS_PREFIX = `opfs://${OPFS_ROOT}/`;

interface BrowserStorageManager {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
    persist?: () => Promise<boolean>;
}

function storageManager(): BrowserStorageManager | undefined {
    return typeof navigator === 'undefined'
        ? undefined
        : (navigator.storage as BrowserStorageManager | undefined);
}

function isNotFoundError(error: unknown): boolean {
    return (
        !!error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'NotFoundError'
    );
}

function parseOpfsPath(
    path: string
): { directory: string; fileName: string } | null {
    if (!path.startsWith(OPFS_PREFIX)) return null;
    const relative = path.slice(OPFS_PREFIX.length);
    const separator = relative.indexOf('/');
    if (separator <= 0 || separator === relative.length - 1) return null;
    const directory = relative.slice(0, separator);
    const fileName = relative.slice(separator + 1);
    if (
        !/^[a-z0-9-]+$/iu.test(directory) ||
        !/^[a-z0-9._-]+$/iu.test(fileName)
    ) {
        return null;
    }
    return { directory, fileName };
}

export function privateMediaPath(directory: string, fileName: string): string {
    return `${OPFS_PREFIX}${directory}/${fileName}`;
}

export class BrowserPrivateStorage {
    private dbPromise: Promise<IDBDatabase> | null = null;
    private readonly downloads = new BrowserDownloadStore(
        () => this.database(),
        DOWNLOAD_STORE
    );
    private readonly recordings = new BrowserRecordingStore(
        () => this.database(),
        RECORDING_STORE
    );

    async requestPersistence(): Promise<void> {
        try {
            await storageManager()?.persist?.();
        } catch {
            // Persistence is advisory. OPFS remains usable when denied.
        }
    }

    listDownloads(): Promise<DownloadItem[]> {
        return this.downloads.list();
    }

    getDownload(id: number): Promise<DownloadItem | undefined> {
        return this.downloads.get(id);
    }

    sanitizeDownload(id: number): Promise<DownloadItem | undefined> {
        return this.downloads.sanitize(id);
    }

    putDownload(item: DownloadItem): Promise<void> {
        return this.downloads.put(item);
    }

    claimDownload(item: DownloadItem, ownerId: string): Promise<boolean> {
        return this.downloads.claim(item, ownerId);
    }

    putDownloadIfAbsent(item: DownloadItem): Promise<DownloadItem> {
        return this.downloads.putIfAbsent(item);
    }

    async claimDownloadForResume(
        id: number,
        ownerId: string,
        leaseUntil: number,
        updatedAt: string,
        capturedSourceId?: string
    ): Promise<BrowserDownloadResumeClaim | null> {
        return this.downloads.claimForResume(
            id,
            ownerId,
            leaseUntil,
            updatedAt,
            capturedSourceId
        );
    }

    claimDownloadForRedownload(
        id: number,
        ownerId: string,
        leaseUntil: number,
        updatedAt: string,
        capturedSourceId?: string
    ): Promise<BrowserDownloadRedownloadClaim | null> {
        return this.downloads.claimForRedownload(
            id,
            ownerId,
            leaseUntil,
            updatedAt,
            capturedSourceId
        );
    }

    restoreDownloadClaim(
        id: number,
        ownerId: string,
        previous: DownloadItem
    ): Promise<boolean> {
        return this.downloads.restoreClaim(id, ownerId, previous);
    }

    pauseOwnedDownloadClaim(
        id: number,
        ownerId: string,
        errorMessage: string,
        updatedAt: string
    ): Promise<boolean> {
        return this.downloads.pauseOwnedClaim(
            id,
            ownerId,
            errorMessage,
            updatedAt
        );
    }

    putDownloadIfOwned(item: DownloadItem, ownerId: string): Promise<boolean> {
        return this.downloads.putIfOwned(item, ownerId);
    }

    refreshDownloadLease(
        id: number,
        ownerId: string,
        leaseUntil: number
    ): Promise<boolean> {
        return this.downloads.refreshLease(id, ownerId, leaseUntil);
    }

    recoverExpiredDownload(
        id: number,
        expectedOwnerId: string | undefined,
        expectedLeaseUntil: number | undefined,
        expiredAt: number,
        errorMessage: string,
        updatedAt: string
    ): Promise<boolean> {
        return this.downloads.recoverExpired(
            id,
            expectedOwnerId,
            expectedLeaseUntil,
            expiredAt,
            errorMessage,
            updatedAt
        );
    }

    updateDownloadMetadata(
        id: number,
        posterUrl: string | undefined,
        metadataSnapshot: DownloadMetadataSnapshot | undefined,
        updatedAt: string
    ): Promise<boolean> {
        return this.downloads.updateMetadata(
            id,
            posterUrl,
            metadataSnapshot,
            updatedAt
        );
    }

    updateDownloadAvailability(
        expected: DownloadItem,
        fileAvailability: DownloadItem['fileAvailability'],
        updatedAt: string
    ): Promise<boolean> {
        return this.downloads.updateAvailability(
            expected,
            fileAvailability,
            updatedAt
        );
    }

    deleteDownload(id: number): Promise<void> {
        return this.downloads.delete(id);
    }

    listRecordings(): Promise<RecordingItem[]> {
        return this.recordings.list();
    }

    getRecording(id: number): Promise<RecordingItem | undefined> {
        return this.recordings.get(id);
    }

    putRecording(item: RecordingItem): Promise<void> {
        return this.recordings.put(item);
    }

    putRecordingIfOwned(
        item: RecordingItem,
        ownerId: string
    ): Promise<boolean> {
        return this.recordings.putIfOwned(item, ownerId);
    }

    refreshRecordingLease(
        id: number,
        ownerId: string,
        leaseUntil: number
    ): Promise<boolean> {
        return this.recordings.refreshLease(id, ownerId, leaseUntil);
    }

    recoverExpiredRecording(
        item: RecordingItem,
        expectedOwnerId: string | undefined,
        expiredAt: number
    ): Promise<boolean> {
        return this.recordings.recoverExpired(item, expectedOwnerId, expiredAt);
    }

    updateRecordingAvailability(
        expected: RecordingItem,
        availability: RecordingItem['fileAvailability'],
        updatedAt: string
    ): Promise<boolean> {
        return this.recordings.updateAvailability(
            expected,
            availability,
            updatedAt
        );
    }

    updateRecordingPrograms(
        expected: RecordingItem,
        programs: RecordingProgramSnapshot[],
        updatedAt: string
    ): Promise<boolean> {
        return this.recordings.updatePrograms(expected, programs, updatedAt);
    }

    claimRecordingRemoval(
        id: number,
        token: string,
        requesterOwnerId: string,
        now: number
    ): Promise<RecordingRemovalClaim> {
        return this.recordings.claimRemoval(id, token, requesterOwnerId, now);
    }

    completeRecordingRemoval(id: number, token: string): Promise<boolean> {
        return this.recordings.completeRemoval(id, token);
    }

    releaseRecordingRemoval(id: number, token: string): Promise<boolean> {
        return this.recordings.releaseRemoval(id, token);
    }

    deleteRecording(id: number): Promise<void> {
        return this.recordings.delete(id);
    }

    async getFileHandle(
        filePath: string,
        create: boolean
    ): Promise<FileSystemFileHandle> {
        const parsed = parseOpfsPath(filePath);
        if (!parsed) {
            throw new Error(BROWSER_MEDIA_MESSAGES.storagePathInvalid);
        }
        const root = await this.rootDirectory();
        const directory = await root.getDirectoryHandle(parsed.directory, {
            create,
        });
        return directory.getFileHandle(parsed.fileName, { create });
    }

    async getFile(filePath: string): Promise<File | null> {
        try {
            return await (await this.getFileHandle(filePath, false)).getFile();
        } catch {
            return null;
        }
    }

    async deleteFile(filePath?: string): Promise<void> {
        if (!filePath) return;
        const parsed = parseOpfsPath(filePath);
        if (!parsed) {
            throw new Error(BROWSER_MEDIA_MESSAGES.storagePathInvalid);
        }
        try {
            const root = await this.rootDirectory();
            const directory = await root.getDirectoryHandle(parsed.directory);
            await directory.removeEntry(parsed.fileName);
        } catch (error) {
            if (isNotFoundError(error)) return;
            throw error;
        }
    }

    private async database(): Promise<IDBDatabase> {
        if (this.dbPromise) return this.dbPromise;
        const attempt = new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onerror = () => reject(request.error);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(DOWNLOAD_STORE)) {
                    db.createObjectStore(DOWNLOAD_STORE, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(RECORDING_STORE)) {
                    db.createObjectStore(RECORDING_STORE, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
        });
        this.dbPromise = attempt;
        try {
            return await attempt;
        } catch (error) {
            if (this.dbPromise === attempt) this.dbPromise = null;
            throw error;
        }
    }

    private async rootDirectory(): Promise<FileSystemDirectoryHandle> {
        const root = await storageManager()?.getDirectory?.();
        if (!root) {
            throw new Error(BROWSER_MEDIA_MESSAGES.storageUnavailable);
        }
        return root.getDirectoryHandle(OPFS_ROOT, { create: true });
    }
}
