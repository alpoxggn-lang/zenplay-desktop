import { BrowserDownloadPresence } from './browser-download-presence';

class TestBroadcastChannel extends EventTarget {
    static readonly channels = new Set<TestBroadcastChannel>();

    constructor(readonly name: string) {
        super();
        TestBroadcastChannel.channels.add(this);
    }

    postMessage(message: unknown): void {
        for (const channel of TestBroadcastChannel.channels) {
            if (channel !== this && channel.name === this.name) {
                channel.dispatchEvent(
                    new MessageEvent('message', { data: message })
                );
            }
        }
    }

    close(): void {
        TestBroadcastChannel.channels.delete(this);
    }
}

describe('BrowserDownloadPresence', () => {
    const original = Object.getOwnPropertyDescriptor(
        globalThis,
        'BroadcastChannel'
    );

    beforeEach(() => {
        TestBroadcastChannel.channels.clear();
        Object.defineProperty(globalThis, 'BroadcastChannel', {
            configurable: true,
            value: TestBroadcastChannel,
        });
    });

    afterEach(() => {
        if (original) {
            Object.defineProperty(globalThis, 'BroadcastChannel', original);
        } else {
            Reflect.deleteProperty(
                globalThis as typeof globalThis & {
                    BroadcastChannel?: typeof BroadcastChannel;
                },
                'BroadcastChannel'
            );
        }
    });

    it('answers a liveness probe from another open tab', async () => {
        const owner = new BrowserDownloadPresence();
        const observer = new BrowserDownloadPresence();
        owner.activate('owner-tab', 42, Date.now() - 1);

        await expect(
            observer.ownerObservable('owner-tab', 42, Date.now())
        ).resolves.toBe(true);

        owner.release('owner-tab', 42);
        await expect(
            observer.ownerObservable('owner-tab', 42, Date.now())
        ).resolves.toBe(false);
    });
});
