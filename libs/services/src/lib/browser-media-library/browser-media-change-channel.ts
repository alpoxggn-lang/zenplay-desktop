export type BrowserMediaLibraryKind = 'downloads' | 'recordings';

interface BrowserMediaChangeMessage {
    readonly version: 1;
    readonly sourceId: string;
    readonly kind: BrowserMediaLibraryKind;
}

function isMessage(value: unknown): value is BrowserMediaChangeMessage {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<BrowserMediaChangeMessage>;
    return (
        candidate.version === 1 &&
        typeof candidate.sourceId === 'string' &&
        ['downloads', 'recordings'].includes(candidate.kind ?? '')
    );
}

/** Sends compact invalidation events; each tab reloads authoritative IndexedDB. */
export class BrowserMediaChangeChannel {
    private readonly sourceId =
        globalThis.crypto?.randomUUID?.() ??
        `media-${Date.now()}-${Math.random()}`;
    private readonly channel =
        typeof window !== 'undefined' &&
        typeof window.BroadcastChannel === 'function'
            ? new window.BroadcastChannel('zenplay-browser-media-changes-v1')
            : null;

    constructor(onExternalChange: (kind: BrowserMediaLibraryKind) => void) {
        this.channel?.addEventListener('message', (event) => {
            if (!isMessage(event.data) || event.data.sourceId === this.sourceId)
                return;
            onExternalChange(event.data.kind);
        });
    }

    publish(kind: BrowserMediaLibraryKind): void {
        this.channel?.postMessage({
            version: 1,
            sourceId: this.sourceId,
            kind,
        } satisfies BrowserMediaChangeMessage);
    }
}
