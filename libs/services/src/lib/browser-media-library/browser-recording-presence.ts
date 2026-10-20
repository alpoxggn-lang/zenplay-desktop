const CHANNEL_NAME = 'zenplay-browser-recordings-v1';
const PROBE_WAIT_MS = 120;
const OBSERVATION_GRACE_MS = 30_000;
const MAX_OBSERVED_LEASE_MS = 30 * 60_000;

export function nextRecordingOwnerId(): string {
    return (
        globalThis.crypto?.randomUUID?.() ??
        `recording-${Date.now()}-${Math.random()}`
    );
}

type PresenceState = 'active' | 'released' | 'probe';

interface PresenceMessage {
    readonly version: 1;
    readonly state: PresenceState;
    readonly ownerId: string;
    readonly recordingId: number;
    readonly observedUntil?: number;
}

export interface BrowserRecordingPresencePort {
    activate(ownerId: string, recordingId: number, leaseUntil: number): void;
    release(ownerId: string, recordingId: number): void;
    ownerObservable(
        ownerId: string,
        recordingId: number,
        now: number
    ): Promise<boolean>;
}

function key(ownerId: string, recordingId: number): string {
    return `${ownerId}:${recordingId}`;
}

function isMessage(value: unknown): value is PresenceMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Partial<PresenceMessage>;
    return (
        message.version === 1 &&
        ['active', 'released', 'probe'].includes(message.state ?? '') &&
        typeof message.ownerId === 'string' &&
        Number.isSafeInteger(message.recordingId)
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

/** Cross-tab liveness supplement for leases that mobile browsers may throttle. */
export class BrowserRecordingPresence implements BrowserRecordingPresencePort {
    private readonly local = new Map<string, PresenceMessage>();
    private readonly observed = new Map<string, number>();
    private readonly channel = openPresenceChannel();

    constructor() {
        this.channel?.addEventListener('message', (event) => {
            if (!isMessage(event.data)) return;
            this.receive(event.data);
        });
    }

    activate(ownerId: string, recordingId: number, leaseUntil: number): void {
        const message: PresenceMessage = {
            version: 1,
            state: 'active',
            ownerId,
            recordingId,
            observedUntil: leaseUntil,
        };
        this.local.set(key(ownerId, recordingId), message);
        this.channel?.postMessage(message);
    }

    release(ownerId: string, recordingId: number): void {
        this.local.delete(key(ownerId, recordingId));
        this.channel?.postMessage({
            version: 1,
            state: 'released',
            ownerId,
            recordingId,
        } satisfies PresenceMessage);
    }

    async ownerObservable(
        ownerId: string,
        recordingId: number,
        now: number
    ): Promise<boolean> {
        const entryKey = key(ownerId, recordingId);
        if ((this.observed.get(entryKey) ?? 0) > now) return true;
        if (!this.channel) return false;
        this.channel.postMessage({
            version: 1,
            state: 'probe',
            ownerId,
            recordingId,
        } satisfies PresenceMessage);
        await new Promise<void>((resolve) =>
            setTimeout(resolve, PROBE_WAIT_MS)
        );
        return (this.observed.get(entryKey) ?? 0) > Date.now();
    }

    private receive(message: PresenceMessage): void {
        const entryKey = key(message.ownerId, message.recordingId);
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
        const until = Math.min(
            now + MAX_OBSERVED_LEASE_MS,
            Math.max(now + OBSERVATION_GRACE_MS, message.observedUntil ?? 0)
        );
        this.observed.set(entryKey, until);
    }
}
