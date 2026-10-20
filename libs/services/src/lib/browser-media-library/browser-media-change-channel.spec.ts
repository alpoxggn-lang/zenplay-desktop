import { BrowserMediaChangeChannel } from './browser-media-change-channel';

class FakeBroadcastChannel {
    static readonly instances: FakeBroadcastChannel[] = [];
    private listener?: (event: MessageEvent) => void;

    constructor(readonly name: string) {
        FakeBroadcastChannel.instances.push(this);
    }

    addEventListener(
        type: string,
        listener: (event: MessageEvent) => void
    ): void {
        if (type === 'message') this.listener = listener;
    }

    postMessage(data: unknown): void {
        for (const target of FakeBroadcastChannel.instances) {
            if (target !== this && target.name === this.name) {
                target.listener?.({ data } as MessageEvent);
            }
        }
    }
}

describe('BrowserMediaChangeChannel', () => {
    const original = Object.getOwnPropertyDescriptor(
        window,
        'BroadcastChannel'
    );

    beforeEach(() => {
        FakeBroadcastChannel.instances.length = 0;
        Object.defineProperty(window, 'BroadcastChannel', {
            configurable: true,
            value: FakeBroadcastChannel,
        });
    });

    afterEach(() => {
        if (original) {
            Object.defineProperty(window, 'BroadcastChannel', original);
        } else {
            Reflect.deleteProperty(window, 'BroadcastChannel');
        }
    });

    it('invalidates another tab without echoing back to the publisher', () => {
        const first = jest.fn();
        const second = jest.fn();
        const firstChannel = new BrowserMediaChangeChannel(first);
        new BrowserMediaChangeChannel(second);

        firstChannel.publish('downloads');

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith('downloads');
    });
});
