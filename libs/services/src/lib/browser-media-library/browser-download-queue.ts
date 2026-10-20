import type { DownloadMetadataSnapshot } from '@iptvnator/shared/interfaces';
import type { DownloadItem } from '../downloads.models';
import { withBrowserDownloadLock } from './browser-download-lock';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import type { BrowserPrivateStorage } from './browser-private-storage';
import { transferBrowserDownload } from './browser-download-transfer';
import type { BrowserDownloadPresencePort } from './browser-download-presence';

const MAX_CONCURRENT_DOWNLOADS = 2;
const OWNER_LEASE_MS = 60_000;
const OWNER_HEARTBEAT_MS = 15_000;

interface ActiveDownload {
    readonly controller: AbortController;
    readonly generation: number;
    readonly completion: Promise<void>;
}

interface QueuedDownload {
    readonly item: DownloadItem;
    readonly offset: number;
    readonly rollback?: DownloadItem;
}

/** Owns the in-tab FIFO and releases IndexedDB claims if a lock is lost. */
export class BrowserDownloadQueue {
    private readonly active = new Map<number, ActiveDownload>();
    private readonly pending: QueuedDownload[] = [];
    private pendingHeartbeat: ReturnType<typeof setInterval> | null = null;
    private generation = 0;

    constructor(
        private readonly storage: BrowserPrivateStorage,
        private readonly ownerId: string,
        private readonly emitChange: () => void,
        private readonly presence: BrowserDownloadPresencePort
    ) {}

    contains(id: number): boolean {
        return (
            this.active.has(id) ||
            this.pending.some(({ item }) => item.id === id)
        );
    }

    enqueue(item: DownloadItem, offset: number, rollback?: DownloadItem): void {
        this.removePending(item.id);
        this.pending.push({ item, offset, rollback });
        this.presence.activate(
            this.ownerId,
            item.id,
            item.browserLeaseUntil ?? Date.now() + OWNER_LEASE_MS
        );
        this.drain();
        this.updatePendingHeartbeat();
    }

    async stop(id: number): Promise<void> {
        this.removePending(id);
        const active = this.active.get(id);
        active?.controller.abort();
        await active?.completion;
    }

    updatePendingMetadata(
        id: number,
        snapshot: DownloadMetadataSnapshot
    ): void {
        const pending = this.pending.find(({ item }) => item.id === id);
        if (pending) pending.item.metadataSnapshot = snapshot;
    }

    private removePending(id: number): void {
        const index = this.pending.findIndex(({ item }) => item.id === id);
        if (index >= 0) {
            this.pending.splice(index, 1);
            this.presence.release(this.ownerId, id);
        }
        this.updatePendingHeartbeat();
    }

    private drain(): void {
        while (
            this.active.size < MAX_CONCURRENT_DOWNLOADS &&
            this.pending.length > 0
        ) {
            const next = this.pending.shift();
            if (next) this.beginTransfer(next);
        }
        this.updatePendingHeartbeat();
    }

    private beginTransfer(next: QueuedDownload): void {
        const { item, offset, rollback } = next;
        const generation = ++this.generation;
        const controller = new AbortController();
        const lockedCompletion = withBrowserDownloadLock(item.id, true, () =>
            transferBrowserDownload(
                this.storage,
                item,
                offset,
                controller,
                this.emitChange,
                this.ownerId
            )
        ).then(async (acquired) => {
            if (acquired) return;
            if (rollback) {
                await this.storage.restoreDownloadClaim(
                    item.id,
                    this.ownerId,
                    rollback
                );
            } else {
                await this.storage.pauseOwnedDownloadClaim(
                    item.id,
                    this.ownerId,
                    BROWSER_MEDIA_MESSAGES.downloadActiveOtherTab,
                    new Date().toISOString()
                );
            }
            this.emitChange();
        });
        const settled = lockedCompletion.finally(() => {
            this.presence.release(this.ownerId, item.id);
            if (this.active.get(item.id)?.generation === generation) {
                this.active.delete(item.id);
                this.drain();
            }
        });
        this.active.set(item.id, {
            controller,
            generation,
            completion: settled,
        });
        void settled.catch(() => undefined);
    }

    private updatePendingHeartbeat(): void {
        if (this.pending.length > 0 && !this.pendingHeartbeat) {
            this.pendingHeartbeat = setInterval(() => {
                void this.refreshPendingLeases();
            }, OWNER_HEARTBEAT_MS);
            return;
        }
        if (this.pending.length === 0 && this.pendingHeartbeat) {
            clearInterval(this.pendingHeartbeat);
            this.pendingHeartbeat = null;
        }
    }

    private async refreshPendingLeases(): Promise<void> {
        const leaseUntil = Date.now() + OWNER_LEASE_MS;
        await Promise.all(
            this.pending.map(async ({ item }) => {
                const refreshed = await this.storage.refreshDownloadLease(
                    item.id,
                    this.ownerId,
                    leaseUntil
                );
                if (refreshed) {
                    item.browserLeaseUntil = leaseUntil;
                    this.presence.activate(this.ownerId, item.id, leaseUntil);
                }
            })
        );
    }
}
