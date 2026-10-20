import type { RecordingItem } from '../recordings.models';
import type { BrowserPrivateStorage } from './browser-private-storage';
import type { BrowserRecordingPresencePort } from './browser-recording-presence';

const OWNER_LEASE_MS = 5 * 60_000;
const HIDDEN_OWNER_LEASE_MS = 30 * 60_000;
const OWNER_HEARTBEAT_MS = 20_000;

export class BrowserRecordingLease {
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private stopped = false;
    private readonly visibilityListener = () => void this.renew();

    constructor(
        private readonly storage: BrowserPrivateStorage,
        private readonly item: RecordingItem,
        private readonly ownerId: string,
        private readonly presence: BrowserRecordingPresencePort,
        private readonly ownershipLost: () => void
    ) {}

    start(): void {
        document.addEventListener('visibilitychange', this.visibilityListener);
        window.addEventListener('pageshow', this.visibilityListener);
        this.presence.activate(
            this.ownerId,
            this.item.id,
            this.item.browserLeaseUntil ?? Date.now() + OWNER_LEASE_MS
        );
        this.heartbeat = setInterval(
            () => void this.renew(),
            OWNER_HEARTBEAT_MS
        );
    }

    touch(now = Date.now()): number {
        const leaseUntil = now + this.currentDuration();
        this.item.browserLeaseUntil = Math.max(
            this.item.browserLeaseUntil ?? 0,
            leaseUntil
        );
        this.presence.activate(this.ownerId, this.item.id, leaseUntil);
        return leaseUntil;
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        document.removeEventListener(
            'visibilitychange',
            this.visibilityListener
        );
        window.removeEventListener('pageshow', this.visibilityListener);
        this.presence.release(this.ownerId, this.item.id);
    }

    private currentDuration(): number {
        return document.visibilityState === 'hidden'
            ? HIDDEN_OWNER_LEASE_MS
            : OWNER_LEASE_MS;
    }

    private async renew(): Promise<void> {
        if (this.stopped) return;
        const leaseUntil = this.touch();
        try {
            const refreshed = await this.storage.refreshRecordingLease(
                this.item.id,
                this.ownerId,
                leaseUntil
            );
            if (!refreshed) this.ownershipLost();
        } catch {
            this.ownershipLost();
        }
    }
}
