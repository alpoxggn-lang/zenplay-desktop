import type { DownloadMetadataSnapshot } from '@iptvnator/shared/interfaces';
import type { DownloadItem } from '../downloads.models';
import { sanitizeBrowserDownloadItem } from './browser-download-item';

export interface BrowserDownloadResumeClaim {
    readonly item: DownloadItem;
    readonly offset: number;
    readonly previous: DownloadItem;
}

export interface BrowserDownloadRedownloadClaim {
    readonly item: DownloadItem;
    readonly previous: DownloadItem;
}

type DatabaseProvider = () => Promise<IDBDatabase>;

/** Atomic IndexedDB transitions shared by every browser tab. */
export class BrowserDownloadStore {
    constructor(
        private readonly database: DatabaseProvider,
        private readonly storeName: string
    ) {}

    list(): Promise<DownloadItem[]> {
        return this.readAll();
    }

    get(id: number): Promise<DownloadItem | undefined> {
        return this.read(id);
    }

    put(item: DownloadItem): Promise<void> {
        return this.write(sanitizeBrowserDownloadItem(item));
    }

    sanitize(id: number): Promise<DownloadItem | undefined> {
        return this.sanitizeRow(id);
    }

    claim(item: DownloadItem, ownerId: string): Promise<boolean> {
        return this.compareAndWrite(item, (current) =>
            Boolean(
                current?.id === item.id &&
                current.status === 'queued' &&
                (!current.browserOwnerId || current.browserOwnerId === ownerId)
            )
        );
    }

    putIfAbsent(item: DownloadItem): Promise<DownloadItem> {
        return this.createIfAbsent(item);
    }

    async claimForResume(
        id: number,
        ownerId: string,
        leaseUntil: number,
        updatedAt: string
    ): Promise<BrowserDownloadResumeClaim | null> {
        let claim: BrowserDownloadResumeClaim | null = null;
        await this.update(id, (current) => {
            if (!current) return null;
            const sanitized = sanitizeBrowserDownloadItem(current);
            if (
                !sanitized.url ||
                !['paused', 'failed', 'canceled'].includes(sanitized.status)
            ) {
                return JSON.stringify(current) === JSON.stringify(sanitized)
                    ? null
                    : sanitized;
            }
            const previous = { ...sanitized };
            const offset =
                sanitized.status === 'canceled'
                    ? 0
                    : (sanitized.bytesDownloaded ?? 0);
            const item: DownloadItem = {
                ...sanitized,
                status: 'queued',
                browserOwnerId: ownerId,
                browserLeaseUntil: leaseUntil,
                errorMessage: undefined,
                bytesDownloaded: offset,
                updatedAt,
            };
            claim = { item, offset, previous };
            return item;
        });
        return claim;
    }

    async claimForRedownload(
        id: number,
        ownerId: string,
        leaseUntil: number,
        updatedAt: string
    ): Promise<BrowserDownloadRedownloadClaim | null> {
        let claim: BrowserDownloadRedownloadClaim | null = null;
        await this.update(id, (current) => {
            if (!current) return null;
            const sanitized = sanitizeBrowserDownloadItem(current);
            if (
                !sanitized.url ||
                sanitized.status !== 'completed' ||
                sanitized.fileAvailability !== 'missing'
            ) {
                return JSON.stringify(current) === JSON.stringify(sanitized)
                    ? null
                    : sanitized;
            }
            const previous = { ...sanitized };
            const item: DownloadItem = {
                ...sanitized,
                status: 'queued',
                bytesDownloaded: 0,
                totalBytes: undefined,
                resumeValidator: undefined,
                mediaSourceId: undefined,
                errorMessage: undefined,
                browserOwnerId: ownerId,
                browserLeaseUntil: leaseUntil,
                updatedAt,
            };
            claim = { item, previous };
            return item;
        });
        return claim;
    }

    restoreClaim(
        id: number,
        ownerId: string,
        previous: DownloadItem
    ): Promise<boolean> {
        return this.update(id, (current) => {
            if (
                !current ||
                current.status !== 'queued' ||
                current.browserOwnerId !== ownerId
            ) {
                return null;
            }
            return sanitizeBrowserDownloadItem(previous);
        });
    }

    pauseOwnedClaim(
        id: number,
        ownerId: string,
        errorMessage: string,
        updatedAt: string
    ): Promise<boolean> {
        return this.update(id, (current) => {
            if (
                !current ||
                !['queued', 'downloading'].includes(current.status) ||
                current.browserOwnerId !== ownerId
            ) {
                return null;
            }
            return sanitizeBrowserDownloadItem({
                ...current,
                status: 'paused',
                browserOwnerId: undefined,
                browserLeaseUntil: undefined,
                errorMessage,
                updatedAt,
            });
        });
    }

    putIfOwned(item: DownloadItem, ownerId: string): Promise<boolean> {
        return this.compareAndWrite(
            item,
            (current) =>
                current?.browserOwnerId === ownerId &&
                current.status === 'downloading'
        );
    }

    refreshLease(
        id: number,
        ownerId: string,
        leaseUntil: number
    ): Promise<boolean> {
        return this.update(id, (current) => {
            if (
                !current ||
                current.browserOwnerId !== ownerId ||
                !['queued', 'downloading'].includes(current.status)
            ) {
                return null;
            }
            return sanitizeBrowserDownloadItem({
                ...current,
                browserLeaseUntil: leaseUntil,
            });
        });
    }

    recoverExpired(
        id: number,
        expectedOwnerId: string | undefined,
        expectedLeaseUntil: number | undefined,
        expiredAt: number,
        errorMessage: string,
        updatedAt: string
    ): Promise<boolean> {
        return this.update(id, (current) => {
            if (!current) return null;
            const item = sanitizeBrowserDownloadItem(current);
            if (
                !['queued', 'downloading'].includes(item.status) ||
                item.browserOwnerId !== expectedOwnerId ||
                item.browserLeaseUntil !== expectedLeaseUntil ||
                (item.browserLeaseUntil ?? 0) > expiredAt
            ) {
                return null;
            }
            return sanitizeBrowserDownloadItem({
                ...item,
                status: 'paused',
                browserOwnerId: undefined,
                browserLeaseUntil: undefined,
                errorMessage,
                updatedAt,
            });
        });
    }

    updateMetadata(
        id: number,
        posterUrl: string | undefined,
        metadataSnapshot: DownloadMetadataSnapshot | undefined,
        updatedAt: string
    ): Promise<boolean> {
        return this.update(id, (current) =>
            current
                ? sanitizeBrowserDownloadItem({
                      ...current,
                      posterUrl,
                      metadataSnapshot,
                      updatedAt,
                  })
                : null
        );
    }

    updateAvailability(
        expected: DownloadItem,
        fileAvailability: DownloadItem['fileAvailability'],
        updatedAt: string
    ): Promise<boolean> {
        return this.update(expected.id, (current) => {
            if (
                !current ||
                current.status !== expected.status ||
                current.filePath !== expected.filePath ||
                current.updatedAt !== expected.updatedAt ||
                current.fileAvailability !== expected.fileAvailability
            ) {
                return null;
            }
            return sanitizeBrowserDownloadItem({
                ...current,
                fileAvailability,
                updatedAt,
            });
        });
    }

    delete(id: number): Promise<void> {
        return this.deleteRow(id);
    }

    private async readAll(): Promise<DownloadItem[]> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const request = db
                .transaction(this.storeName, 'readonly')
                .objectStore(this.storeName)
                .getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () =>
                resolve((request.result as DownloadItem[]) ?? []);
        });
    }

    private async read(id: number): Promise<DownloadItem | undefined> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const request = db
                .transaction(this.storeName, 'readonly')
                .objectStore(this.storeName)
                .get(id);
            request.onerror = () => reject(request.error);
            request.onsuccess = () =>
                resolve(request.result as DownloadItem | undefined);
        });
    }

    private async write(item: DownloadItem): Promise<void> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
            transaction.objectStore(this.storeName).put(item);
        });
    }

    private async compareAndWrite(
        item: DownloadItem,
        predicate: (current: DownloadItem | undefined) => boolean
    ): Promise<boolean> {
        const sanitized = sanitizeBrowserDownloadItem(item);
        return this.update(item.id, (current) =>
            predicate(current) ? sanitized : null
        );
    }

    private async createIfAbsent(item: DownloadItem): Promise<DownloadItem> {
        const sanitizedItem = sanitizeBrowserDownloadItem(item);
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();
            let result = sanitizedItem;
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const existing = (request.result as DownloadItem[]).find(
                    (entry) =>
                        entry.playlistId === sanitizedItem.playlistId &&
                        entry.xtreamId === sanitizedItem.xtreamId &&
                        entry.contentType === sanitizedItem.contentType
                );
                if (existing) {
                    result = sanitizeBrowserDownloadItem(existing);
                    if (JSON.stringify(existing) !== JSON.stringify(result)) {
                        store.put(result);
                    }
                } else store.put(sanitizedItem);
            };
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve(result);
        });
    }

    private async update(
        id: number,
        change: (current: DownloadItem | undefined) => DownloadItem | null
    ): Promise<boolean> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(id);
            let updated = false;
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const next = change(request.result as DownloadItem | undefined);
                if (!next) return;
                updated = true;
                store.put(next);
            };
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve(updated);
        });
    }

    private async sanitizeRow(id: number): Promise<DownloadItem | undefined> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(id);
            let result: DownloadItem | undefined;
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const current = request.result as DownloadItem | undefined;
                if (!current) return;
                result = sanitizeBrowserDownloadItem(current);
                if (JSON.stringify(current) !== JSON.stringify(result)) {
                    store.put(result);
                }
            };
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve(result);
        });
    }

    private async deleteRow(id: number): Promise<void> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
            transaction.objectStore(this.storeName).delete(id);
        });
    }
}
