import { BrowserRecordingPresence } from './browser-recording-presence';

class TestBroadcastChannel extends EventTarget {
    static readonly channels = new Set<TestBroadcastChannel>();

    constructor(readonly name: string) {
        super();
        TestBroadcastChannel.channels.add(this);
    }

    postMessage(data: unknown): void {
        for (const channel of TestBroadcastChannel.channels) {
            if (channel === this || channel.name !== this.name) continue;
            channel.dispatchEvent(new MessageEvent('message', { data }));
        }
    }

    close(): void {
        TestBroadcastChannel.channels.delete(this);
    }
}

describe('BrowserRecordingPresence', () => {
    const original = Object.getOwnPropertyDescriptor(
        globalThis,
        'BroadcastChannel'
    );

    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-20T12:00:00Z'));
        TestBroadcastChannel.channels.clear();
        Object.defineProperty(globalThis, 'BroadcastChannel', {
            configurable: true,
            value: TestBroadcastChannel,
        });
    });

    afterEach(() => {
        jest.useRealTimers();
        if (original) {
            Object.defineProperty(globalThis, 'BroadcastChannel', original);
        } else {
            delete (
                globalThis as {
                    BroadcastChannel?: typeof BroadcastChannel;
                }
            ).BroadcastChannel;
        }
    });

    it('probes a throttled owner before treating an expired lease as abandoned', async () => {
        const owner = new BrowserRecordingPresence();
        const observer = new BrowserRecordingPresence();
        owner.activate('mobile-tab', 7, Date.now() + 1_000);
        await jest.advanceTimersByTimeAsync(31_000);

        const observable = observer.ownerObservable(
            'mobile-tab',
            7,
            Date.now()
        );
        await jest.advanceTimersByTimeAsync(120);

        await expect(observable).resolves.toBe(true);
    });
});
