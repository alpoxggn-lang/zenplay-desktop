import type {
    RecordingItem,
    RecordingProgramSnapshot,
} from '../recordings.models';
import { sanitizeBrowserRecordingItem } from './browser-recording-item';

export type RecordingRemovalClaim =
    | { readonly outcome: 'missing' }
    | { readonly outcome: 'active-other-tab' }
    | { readonly outcome: 'claimed'; readonly item: RecordingItem };

type DatabaseProvider = () => Promise<IDBDatabase>;

function nextVersionTimestamp(
    current: string | undefined,
    candidate: string
): string {
    const currentMs = current ? Date.parse(current) : Number.NaN;
    const candidateMs = Date.parse(candidate);
    return new Date(
        Math.max(
            Number.isFinite(currentMs) ? currentMs + 1 : 0,
            Number.isFinite(candidateMs) ? candidateMs : Date.now()
        )
    ).toISOString();
}

export class BrowserRecordingStore {
    constructor(
        private readonly database: DatabaseProvider,
        private readonly storeName: string
    ) {}

    list(): Promise<RecordingItem[]> {
        return this.readAllSanitized();
    }

    get(id: number): Promise<RecordingItem | undefined> {
        return this.sanitizeRow(id);
    }

    put(item: RecordingItem): Promise<void> {
        return this.write(sanitizeBrowserRecordingItem(item));
    }

    putIfOwned(item: RecordingItem, ownerId: string): Promise<boolean> {
        return this.update(item.id, (current) => {
            if (
                current?.status !== 'recording' ||
                current.browserOwnerId !== ownerId ||
                current.browserRemovalToken
            ) {
                return null;
            }
            return item;
        });
    }

    refreshLease(
        id: number,
        ownerId: string,
        leaseUntil: number
    ): Promise<boolean> {
        return this.update(id, (current) => {
            if (
                current?.status !== 'recording' ||
                current.browserOwnerId !== ownerId ||
                current.browserRemovalToken
            ) {
                return null;
            }
            return { ...current, browserLeaseUntil: leaseUntil };
        });
    }

    recoverExpired(
        item: RecordingItem,
        expectedOwnerId: string | undefined,
        expiredAt: number
    ): Promise<boolean> {
        return this.update(item.id, (current) => {
            if (
                current?.status !== 'recording' ||
                current.browserOwnerId !== expectedOwnerId ||
                (current.browserLeaseUntil ?? 0) > expiredAt ||
                current.browserRemovalToken
            ) {
                return null;
            }
            return item;
        });
    }

    updateAvailability(
        expected: RecordingItem,
        availability: RecordingItem['fileAvailability'],
        updatedAt: string
    ): Promise<boolean> {
        return this.update(expected.id, (current) => {
            if (
                !current ||
                current.status !== expected.status ||
                current.filePath !== expected.filePath ||
                current.updatedAt !== expected.updatedAt ||
                current.fileAvailability !== expected.fileAvailability ||
                current.browserRemovalToken !== expected.browserRemovalToken
            ) {
                return null;
            }
            return { ...current, fileAvailability: availability, updatedAt };
        });
    }

    updatePrograms(
        expected: RecordingItem,
        programs: RecordingProgramSnapshot[],
        updatedAt: string
    ): Promise<boolean> {
        return this.update(expected.id, (current) => {
            if (
                !current ||
                current.filePath !== expected.filePath ||
                current.updatedAt !== expected.updatedAt ||
                current.browserRemovalToken ||
                current.browserRemovalToken !== expected.browserRemovalToken
            ) {
                return null;
            }
            return {
                ...current,
                programs,
                updatedAt: nextVersionTimestamp(current.updatedAt, updatedAt),
            };
        });
    }

    claimRemoval(
        id: number,
        token: string,
        requesterOwnerId: string,
        now: number
    ): Promise<RecordingRemovalClaim> {
        return this.transaction(id, (store, current, finish) => {
            if (!current) return finish({ outcome: 'missing' });
            const sanitized = sanitizeBrowserRecordingItem(current);
            const foreignLiveOwner =
                sanitized.status === 'recording' &&
                sanitized.browserOwnerId !== requesterOwnerId &&
                (sanitized.browserLeaseUntil ?? 0) > now;
            if (foreignLiveOwner || sanitized.browserRemovalToken) {
                return finish({ outcome: 'active-other-tab' });
            }
            const claimed = {
                ...sanitized,
                browserRemovalToken: token,
                browserRemovalStartedAt: now,
            };
            store.put(sanitizeBrowserRecordingItem(claimed));
            finish({ outcome: 'claimed', item: claimed });
        });
    }

    completeRemoval(id: number, token: string): Promise<boolean> {
        return this.transaction(id, (store, current, finish) => {
            if (current?.browserRemovalToken !== token) return finish(false);
            store.delete(id);
            finish(true);
        });
    }

    releaseRemoval(id: number, token: string): Promise<boolean> {
        return this.update(id, (current) => {
            if (current?.browserRemovalToken !== token) return null;
            const released = { ...current };
            delete released.browserRemovalToken;
            delete released.browserRemovalStartedAt;
            return released;
        });
    }

    delete(id: number): Promise<void> {
        return this.deleteUnconditionally(id);
    }

    private async readAllSanitized(): Promise<RecordingItem[]> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();
            let result: RecordingItem[] = [];
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const current = (request.result as RecordingItem[]) ?? [];
                result = current.map(sanitizeBrowserRecordingItem);
                current.forEach((item, index) => {
                    if (
                        JSON.stringify(item) !== JSON.stringify(result[index])
                    ) {
                        store.put(result[index]);
                    }
                });
            };
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve(result);
        });
    }

    private async sanitizeRow(id: number): Promise<RecordingItem | undefined> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(id);
            let result: RecordingItem | undefined;
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const current = request.result as RecordingItem | undefined;
                if (!current) return;
                result = sanitizeBrowserRecordingItem(current);
                if (JSON.stringify(current) !== JSON.stringify(result)) {
                    store.put(result);
                }
            };
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve(result);
        });
    }

    private async write(item: RecordingItem): Promise<void> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
            transaction
                .objectStore(this.storeName)
                .put(sanitizeBrowserRecordingItem(item));
        });
    }

    private update(
        id: number,
        mutate: (current: RecordingItem | undefined) => RecordingItem | null
    ): Promise<boolean> {
        return this.transaction(id, (store, current, finish) => {
            const sanitized = current
                ? sanitizeBrowserRecordingItem(current)
                : undefined;
            const next = mutate(sanitized);
            if (!next) return finish(false);
            store.put(sanitizeBrowserRecordingItem(next));
            finish(true);
        });
    }

    private async deleteUnconditionally(id: number): Promise<void> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
            transaction.objectStore(this.storeName).delete(id);
        });
    }

    private async transaction<T>(
        id: number,
        action: (
            store: IDBObjectStore,
            current: RecordingItem | undefined,
            finish: (result: T) => void
        ) => void
    ): Promise<T> {
        const db = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(id);
            let result: T;
            request.onerror = () => reject(request.error);
            request.onsuccess = () =>
                action(
                    store,
                    request.result as RecordingItem | undefined,
                    (value) => {
                        result = value;
                    }
                );
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve(result);
        });
    }
}
