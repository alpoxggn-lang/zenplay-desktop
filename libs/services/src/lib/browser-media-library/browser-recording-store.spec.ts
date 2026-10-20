import type { RecordingProgramSnapshot } from '@iptvnator/shared/interfaces';
import type { RecordingItem } from '../recordings.models';
import { sanitizeBrowserRecordingItem } from './browser-recording-item';
import { BrowserRecordingStore } from './browser-recording-store';

function recordingItem(overrides: Partial<RecordingItem> = {}): RecordingItem {
    const now = '2026-10-20T12:00:00.000Z';
    return {
        id: 1,
        sessionId: 'browser-1',
        status: 'completed',
        filePath: 'opfs://zenplay-private-media/recordings/1.webm',
        fileSizeBytes: 8,
        fileAvailability: 'available',
        channelName: 'Channel',
        startedAt: now,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function memoryDatabase(initial: RecordingItem[] = []) {
    const rows = new Map<number, RecordingItem>(
        initial.map((item) => [item.id, structuredClone(item)])
    );
    const database = {
        transaction: () => {
            let completionQueued = false;
            const transaction: Partial<IDBTransaction> = {};
            const complete = () => {
                if (completionQueued) return;
                completionQueued = true;
                queueMicrotask(() =>
                    transaction.oncomplete?.call(
                        transaction as IDBTransaction,
                        new Event('complete')
                    )
                );
            };
            const request = <T>(value: T): IDBRequest<T> => {
                const result: Partial<IDBRequest<T>> = {};
                queueMicrotask(() => {
                    Object.defineProperty(result, 'result', { value });
                    result.onsuccess?.call(
                        result as IDBRequest<T>,
                        new Event('success')
                    );
                    complete();
                });
                return result as IDBRequest<T>;
            };
            const store = {
                get: (id: number) => request(structuredClone(rows.get(id))),
                getAll: () =>
                    request(
                        [...rows.values()].map((item) => structuredClone(item))
                    ),
                put: (item: RecordingItem) => {
                    rows.set(item.id, structuredClone(item));
                    complete();
                    return {} as IDBRequest<IDBValidKey>;
                },
                delete: (id: number) => {
                    rows.delete(id);
                    complete();
                    return {} as IDBRequest<undefined>;
                },
            };
            transaction.objectStore = () => store as unknown as IDBObjectStore;
            return transaction as IDBTransaction;
        },
    } as unknown as IDBDatabase;
    return { database, rows };
}

function unsafeRecording(logoUrl: string): RecordingItem {
    return {
        ...recordingItem(),
        channelLogoUrl: logoUrl,
        playlistName: 'https://alice:secret@provider.example/list?token=secret',
        programs: [
            {
                title: 'Programme',
                description: 'Description',
                start: '2026-10-20T12:00:00.000Z',
                stop: '2026-10-20T13:00:00.000Z',
                providerUrl: 'https://provider.example/epg?token=secret',
            } as RecordingProgramSnapshot,
        ],
        serverUrl: 'https://provider.example',
        portalUrl: 'https://provider.example/portal?token=secret',
        credentials: { username: 'alice', password: 'secret' },
        requestHeaders: { Authorization: 'Bearer secret' },
        macAddress: '00:11:22:33:44:55',
    } as RecordingItem;
}

describe('sanitizeBrowserRecordingItem', () => {
    it.each([
        'https://provider.example/logo.png',
        'https://alice:secret@provider.example/logo.png',
        '/assets/logo.png?token=secret',
        '/assets/logo.png#private',
    ])('omits an unsafe channel logo URL: %s', (channelLogoUrl) => {
        expect(
            sanitizeBrowserRecordingItem(unsafeRecording(channelLogoUrl))
        ).not.toHaveProperty('channelLogoUrl');
    });

    it('keeps only a clean same-origin logo path', () => {
        expect(
            sanitizeBrowserRecordingItem(
                unsafeRecording(`${location.origin}/assets/channel.png`)
            )
        ).toMatchObject({ channelLogoUrl: '/assets/channel.png' });
    });
});

describe('BrowserRecordingStore persistence allowlist', () => {
    it('drops connection secrets and unknown nested fields on every put', async () => {
        const { database, rows } = memoryDatabase();
        const store = new BrowserRecordingStore(
            async () => database,
            'recordings'
        );

        await store.put(
            unsafeRecording('https://alice:secret@provider.example/logo.png')
        );

        const raw = rows.get(1) as RecordingItem & Record<string, unknown>;
        expect(raw).not.toHaveProperty('channelLogoUrl');
        expect(raw).not.toHaveProperty('playlistName');
        expect(raw).not.toHaveProperty('serverUrl');
        expect(raw).not.toHaveProperty('portalUrl');
        expect(raw).not.toHaveProperty('credentials');
        expect(raw).not.toHaveProperty('requestHeaders');
        expect(raw).not.toHaveProperty('macAddress');
        expect(raw.programs?.[0]).toEqual({
            title: 'Programme',
            description: 'Description',
            start: '2026-10-20T12:00:00.000Z',
            stop: '2026-10-20T13:00:00.000Z',
        });
    });

    it('sanitizes and replaces a legacy row while listing it', async () => {
        const legacy = unsafeRecording('/assets/logo.png?token=secret');
        const { database, rows } = memoryDatabase([legacy]);
        const store = new BrowserRecordingStore(
            async () => database,
            'recordings'
        );

        const [listed] = await store.list();
        const persisted = rows.get(legacy.id) as RecordingItem &
            Record<string, unknown>;

        expect(listed).toEqual(persisted);
        expect(persisted).not.toHaveProperty('channelLogoUrl');
        expect(persisted).not.toHaveProperty('playlistName');
        expect(persisted).not.toHaveProperty('serverUrl');
        expect(persisted).not.toHaveProperty('credentials');
        expect(persisted.programs?.[0]).not.toHaveProperty('providerUrl');
    });
});
