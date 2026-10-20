const CHANNEL_NAME = 'zenplay-browser-downloads-v1';
const PROBE_WAIT_MS = 120;
const OBSERVATION_GRACE_MS = 30_000;
const MAX_OBSERVED_LEASE_MS = 30 * 60_000;

type PresenceState = 'active' | 'released' | 'probe';

interface PresenceMessage {
    readonly version: 1;
    readonly state: PresenceState;
    readonly ownerId: string;
    readonly downloadId: number;
    readonly observedUntil?: number;
}

export interface BrowserDownloadPresencePort {
    activate(ownerId: string, downloadId: number, leaseUntil: number): void;
    release(ownerId: string, downloadId: number): void;
    ownerObservable(
        ownerId: string,
        downloadId: number,
        now: number
    ): Promise<boolean>;
}

function key(ownerId: string, downloadId: number): string {
    return `${ownerId}:${downloadId}`;
}

function isMessage(value: unknown): value is PresenceMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Partial<PresenceMessage>;
    return (
        message.version === 1 &&
        ['active', 'released', 'probe'].includes(message.state ?? '') &&
        typeof message.ownerId === 'string' &&
        Number.isSafeInteger(message.downloadId)
    );
}

function openPresenceChannel(): BroadcastChannel | null {
    try {
        return typeof BroadcastChannel === 'undefined'
            ? null
            : new BroadcastChannel(CHANNEL_NAME);
    } catch {
        return null;
    }
}

/** Protects a throttled but responsive owner when its lease timer is delayed. */
export class BrowserDownloadPresence implements BrowserDownloadPresencePort {
    private readonly local = new Map<string, PresenceMessage>();
    private readonly observed = new Map<string, number>();
    private readonly channel = openPresenceChannel();

    constructor() {
        this.channel?.addEventListener('message', (event) => {
            if (isMessage(event.data)) this.receive(event.data);
        });
    }

    activate(ownerId: string, downloadId: number, leaseUntil: number): void {
        const message: PresenceMessage = {
            version: 1,
            state: 'active',
            ownerId,
            downloadId,
            observedUntil: leaseUntil,
        };
        this.local.set(key(ownerId, downloadId), message);
        this.channel?.postMessage(message);
    }

    release(ownerId: string, downloadId: number): void {
        this.local.delete(key(ownerId, downloadId));
        this.channel?.postMessage({
            version: 1,
            state: 'released',
            ownerId,
            downloadId,
        } satisfies PresenceMessage);
    }

    async ownerObservable(
        ownerId: string,
        downloadId: number,
        now: number
    ): Promise<boolean> {
        const entryKey = key(ownerId, downloadId);
        if (this.local.has(entryKey)) return true;
        if ((this.observed.get(entryKey) ?? 0) > now) return true;
        if (!this.channel) return false;
        this.channel.postMessage({
            version: 1,
            state: 'probe',
            ownerId,
            downloadId,
        } satisfies PresenceMessage);
        await new Promise<void>((resolve) =>
            setTimeout(resolve, PROBE_WAIT_MS)
        );
        return (this.observed.get(entryKey) ?? 0) > Date.now();
    }

    private receive(message: PresenceMessage): void {
        const entryKey = key(message.ownerId, message.downloadId);
        if (message.state === 'probe') {
            const active = this.local.get(entryKey);
            if (!active) return;
            this.channel?.postMessage({
                ...active,
                observedUntil: Math.max(
                    active.observedUntil ?? 0,
                    Date.now() + OBSERVATION_GRACE_MS
                ),
            });
            return;
        }
        if (message.state === 'released') {
            this.observed.delete(entryKey);
            return;
        }
        const now = Date.now();
        this.observed.set(
            entryKey,
            Math.min(
                now + MAX_OBSERVED_LEASE_MS,
                Math.max(
                    now + OBSERVATION_GRACE_MS,
                    message.observedUntil ?? 0
                )
            )
        );
    }
}
