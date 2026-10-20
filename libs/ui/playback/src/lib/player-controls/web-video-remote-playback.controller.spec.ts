import { WebVideoRemotePlaybackController } from './web-video-remote-playback.controller';
import {
    resolveRemotePlaybackTicketRequest,
    resolveRemotePlaybackTicketRevokeUrl,
} from './web-video-remote-playback-source';

const OPAQUE_TOKEN = 't'.repeat(32);
const SECOND_OPAQUE_TOKEN = 'u'.repeat(32);

class FakeRemotePlayback extends EventTarget {
    state: RemotePlaybackState = 'disconnected';
    readonly prompt = jest.fn<Promise<void>, []>(async () => undefined);
    readonly cancelWatchAvailability = jest.fn(async () => undefined);
    private availabilityCallback: ((available: boolean) => void) | null = null;

    constructor(
        private readonly availabilityResult: Promise<number> = Promise.resolve(
            7
        )
    ) {
        super();
    }

    readonly watchAvailability = jest.fn(
        async (callback: (available: boolean) => void) => {
            this.availabilityCallback = callback;
            return this.availabilityResult;
        }
    );

    setAvailable(available: boolean): void {
        this.availabilityCallback?.(available);
    }
}

describe('resolveRemotePlaybackTicketRequest', () => {
    it('accepts only opaque ZenPlay media paths', () => {
        expect(
            resolveRemotePlaybackTicketRequest(
                '/api/media/live/42.m3u8',
                'https://app.example/watch'
            )
        ).toEqual({
            adaptive: false,
            endpoint: 'https://app.example/api/media/cast',
            extension: 'm3u8',
            kind: 'live',
            streamId: '42',
        });
        expect(
            resolveRemotePlaybackTicketRequest(
                '/api/media/adaptive/series/99.mkv/master.m3u8',
                'https://app.example/watch'
            )
        ).toEqual({
            adaptive: true,
            endpoint: 'https://app.example/api/media/cast',
            extension: 'mkv',
            kind: 'series',
            streamId: '99',
        });
    });

    it('rejects provider credentials and arbitrary media URLs', () => {
        expect(
            resolveRemotePlaybackTicketRequest(
                'https://viewer:secret@provider.example/live/42.m3u8',
                'https://app.example/'
            )
        ).toBeNull();
        expect(
            resolveRemotePlaybackTicketRequest(
                'https://provider.example/live/viewer/secret/42.m3u8',
                'https://app.example/'
            )
        ).toBeNull();
        expect(
            resolveRemotePlaybackTicketRequest(
                'https://attacker.example/api/media/movie/42.mp4',
                'https://app.example/'
            )
        ).toBeNull();
    });

    it('derives only a same-origin opaque ticket revocation endpoint', () => {
        const endpoint = 'https://app.example/api/media/cast';
        expect(
            resolveRemotePlaybackTicketRevokeUrl(
                `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
                endpoint
            )
        ).toBe(`https://app.example/api/media/cast/${OPAQUE_TOKEN}`);
        expect(
            resolveRemotePlaybackTicketRevokeUrl(
                'https://attacker.example/media/cast/' +
                    `${OPAQUE_TOKEN}/stream.mp4`,
                endpoint
            )
        ).toBeNull();
        expect(
            resolveRemotePlaybackTicketRevokeUrl(
                '/api/media/cast/short/stream.mp4',
                endpoint
            )
        ).toBeNull();
    });
});

describe('WebVideoRemotePlaybackController', () => {
    let remote: FakeRemotePlayback;
    let originalRemote: PropertyDescriptor | undefined;
    let originalWebkitPicker: PropertyDescriptor | undefined;

    beforeEach(() => {
        remote = new FakeRemotePlayback();
        originalRemote = Object.getOwnPropertyDescriptor(
            HTMLMediaElement.prototype,
            'remote'
        );
        originalWebkitPicker = Object.getOwnPropertyDescriptor(
            HTMLMediaElement.prototype,
            'webkitShowPlaybackTargetPicker'
        );
        Object.defineProperty(HTMLMediaElement.prototype, 'remote', {
            configurable: true,
            get: () => remote,
        });
    });

    afterEach(() => {
        if (originalRemote) {
            Object.defineProperty(
                HTMLMediaElement.prototype,
                'remote',
                originalRemote
            );
        } else {
            Reflect.deleteProperty(HTMLMediaElement.prototype, 'remote');
        }
        if (originalWebkitPicker) {
            Object.defineProperty(
                HTMLMediaElement.prototype,
                'webkitShowPlaybackTargetPicker',
                originalWebkitPicker
            );
        } else {
            Reflect.deleteProperty(
                HTMLMediaElement.prototype,
                'webkitShowPlaybackTargetPicker'
            );
        }
        document.body.replaceChildren();
    });

    it('prepares an opaque ticket and enables the native picker only when a target is available', async () => {
        const fetchMock = jest.fn(async () =>
            mockJsonResponse({
                expiresInSeconds: 900,
                url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
            })
        );
        const source = document.createElement('video');
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(source, '/api/media/movie/42.mp4');
        await settlePromises();

        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost/api/media/cast',
            expect.objectContaining({
                body: JSON.stringify({
                    adaptive: false,
                    extension: 'mp4',
                    kind: 'movie',
                    streamId: '42',
                }),
                credentials: 'include',
                method: 'POST',
            })
        );
        expect(controller.state()).toMatchObject({
            canPrompt: true,
            preparing: false,
            supported: true,
        });

        remote.setAvailable(false);
        expect(controller.state().canPrompt).toBe(false);
        remote.setAvailable(true);
        controller.prompt();
        expect(remote.prompt).toHaveBeenCalledTimes(1);

        controller.detach();
        expect(remote.cancelWatchAvailability).toHaveBeenCalledWith(7);
        expect(controller.state()).toEqual({
            active: false,
            available: null,
            canPrompt: false,
            preparing: false,
            retrying: false,
            supported: false,
        });
    });

    it('never offers remote playback for a direct provider URL', async () => {
        const fetchMock = jest.fn();
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(
            document.createElement('video'),
            'https://provider.example/live/user/password/42.ts'
        );
        await settlePromises();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(controller.state().supported).toBe(false);
    });

    it('uses the native WebKit AirPlay picker on compatible iOS Safari', async () => {
        Object.defineProperty(HTMLMediaElement.prototype, 'remote', {
            configurable: true,
            get: () => undefined,
        });
        const picker = jest.fn();
        Object.defineProperty(
            HTMLMediaElement.prototype,
            'webkitShowPlaybackTargetPicker',
            { configurable: true, value: picker }
        );
        const controller = new WebVideoRemotePlaybackController(
            jest.fn(async () =>
                mockJsonResponse({
                    expiresInSeconds: 900,
                    url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
                })
            ) as typeof fetch
        );

        controller.attach(
            document.createElement('video'),
            '/api/media/movie/42.mp4'
        );
        await settlePromises();
        controller.prompt();

        expect(controller.state().supported).toBe(true);
        expect(picker).toHaveBeenCalledTimes(1);
        controller.detach();
    });

    it('recovers when the WebKit AirPlay picker is cancelled silently', async () => {
        jest.useFakeTimers();
        try {
            Object.defineProperty(HTMLMediaElement.prototype, 'remote', {
                configurable: true,
                get: () => undefined,
            });
            const picker = jest.fn();
            Object.defineProperty(
                HTMLMediaElement.prototype,
                'webkitShowPlaybackTargetPicker',
                { configurable: true, value: picker }
            );
            const controller = new WebVideoRemotePlaybackController(
                jest.fn(async () =>
                    mockJsonResponse({
                        url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
                    })
                ) as typeof fetch
            );

            controller.attach(
                document.createElement('video'),
                '/api/media/movie/42.mp4'
            );
            await settlePromises();
            controller.prompt();
            expect(controller.state().canPrompt).toBe(false);

            jest.advanceTimersByTime(30_000);
            await settlePromises();
            expect(controller.state().canPrompt).toBe(true);
            controller.detach();
        } finally {
            jest.useRealTimers();
        }
    });

    it('ignores and cancels a stale availability watcher after reattach', async () => {
        const pending = deferred<number>();
        const firstRemote = new FakeRemotePlayback(pending.promise);
        remote = firstRemote;
        const fetchMock = jest.fn(async () =>
            mockJsonResponse({
                url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
            })
        );
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );
        controller.attach(
            document.createElement('video'),
            '/api/media/movie/42.mp4'
        );
        await settlePromises();
        controller.detach();

        const secondRemote = new FakeRemotePlayback(Promise.resolve(9));
        remote = secondRemote;
        controller.attach(
            document.createElement('video'),
            '/api/media/movie/43.mp4'
        );
        await settlePromises();
        firstRemote.setAvailable(false);
        expect(controller.state().canPrompt).toBe(true);

        pending.resolve(7);
        await settlePromises();
        expect(firstRemote.cancelWatchAvailability).toHaveBeenCalledWith(7);
        controller.detach();
        expect(secondRemote.cancelWatchAvailability).toHaveBeenCalledWith(9);
    });

    it.each(['resolve', 'reject'] as const)(
        'ignores a stale prompt %s after reattaching and prompting the new source',
        async (outcome) => {
            const firstPrompt = deferred<void>();
            const firstRemote = new FakeRemotePlayback();
            firstRemote.prompt.mockImplementation(() => firstPrompt.promise);
            remote = firstRemote;
            const fetchMock = jest.fn(async () =>
                mockJsonResponse({
                    url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
                })
            );
            const controller = new WebVideoRemotePlaybackController(
                fetchMock as typeof fetch
            );

            controller.attach(
                document.createElement('video'),
                '/api/media/movie/42.mp4'
            );
            await settlePromises();
            controller.prompt();
            expect(firstRemote.prompt).toHaveBeenCalledTimes(1);

            const secondPrompt = deferred<void>();
            const secondRemote = new FakeRemotePlayback();
            secondRemote.prompt.mockImplementation(() => secondPrompt.promise);
            remote = secondRemote;
            controller.attach(
                document.createElement('video'),
                '/api/media/movie/43.mp4'
            );
            await settlePromises();
            controller.prompt();
            expect(secondRemote.prompt).toHaveBeenCalledTimes(1);
            expect(controller.state().canPrompt).toBe(false);

            if (outcome === 'resolve') firstPrompt.resolve();
            else firstPrompt.reject(new Error('picker cancelled'));
            await settlePromises();

            expect(controller.state().canPrompt).toBe(false);
            controller.prompt();
            expect(secondRemote.prompt).toHaveBeenCalledTimes(1);

            secondPrompt.resolve();
            await settlePromises();
            expect(controller.state().canPrompt).toBe(true);
            controller.detach();
        }
    );

    it('revokes a cancelled prompt ticket before preparing a retry', async () => {
        let postCount = 0;
        const fetchMock = jest.fn(async (_input, init?: RequestInit) => {
            if (init?.method === 'DELETE') return mockJsonResponse({});
            const token =
                postCount++ === 0 ? OPAQUE_TOKEN : SECOND_OPAQUE_TOKEN;
            return mockJsonResponse({
                url: `/api/media/cast/${token}/stream.mp4`,
            });
        });
        remote.prompt.mockRejectedValue(new Error('picker cancelled'));
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(
            document.createElement('video'),
            '/api/media/movie/42.mp4'
        );
        await settlePromises();
        controller.prompt();
        await settlePromises();

        expect(fetchMock).toHaveBeenCalledWith(
            `http://localhost/api/media/cast/${OPAQUE_TOKEN}`,
            expect.objectContaining({
                credentials: 'include',
                keepalive: true,
                method: 'DELETE',
            })
        );
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
        ).toHaveLength(2);
        expect(controller.state().canPrompt).toBe(true);
        controller.detach();
    });

    it('keeps its ticket while a resolved picker is still connecting', async () => {
        const fetchMock = jest.fn(async (_input, init?: RequestInit) =>
            init?.method === 'DELETE'
                ? mockJsonResponse({})
                : mockJsonResponse({
                      url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
                  })
        );
        remote.prompt.mockImplementation(async () => {
            remote.state = 'connecting';
        });
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(
            createControllableVideo(true),
            '/api/media/movie/42.mp4'
        );
        await settlePromises();
        controller.prompt();
        await settlePromises();

        expect(controller.state()).toMatchObject({
            active: false,
            canPrompt: false,
        });
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
        ).toHaveLength(0);

        remote.state = 'connected';
        remote.dispatchEvent(new Event('connect'));
        expect(controller.state().active).toBe(true);
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
        ).toHaveLength(0);
        controller.detach();
    });

    it('honours Retry-After after a recoverable ticket throttle', async () => {
        jest.useFakeTimers();
        try {
            let attempts = 0;
            const fetchMock = jest.fn(async (_input, init?: RequestInit) => {
                if (init?.method === 'DELETE') return mockJsonResponse({});
                attempts += 1;
                if (attempts === 1) {
                    return mockJsonResponse(
                        { error: 'rate limited' },
                        { ok: false, retryAfter: '2', status: 429 }
                    );
                }
                return mockJsonResponse({
                    url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
                });
            });
            const controller = new WebVideoRemotePlaybackController(
                fetchMock as typeof fetch
            );

            controller.attach(
                createControllableVideo(true),
                '/api/media/movie/42.mp4'
            );
            await settlePromises();

            expect(controller.state()).toMatchObject({
                preparing: false,
                retrying: true,
                supported: true,
            });
            expect(attempts).toBe(1);
            jest.advanceTimersByTime(1_999);
            await settlePromises();
            expect(attempts).toBe(1);
            jest.advanceTimersByTime(1);
            await settlePromises();
            expect(attempts).toBe(2);
            expect(controller.state()).toMatchObject({
                canPrompt: true,
                retrying: false,
                supported: true,
            });
            controller.detach();
        } finally {
            jest.useRealTimers();
        }
    });

    it('revokes prepared tickets on source switch and detach', async () => {
        let postCount = 0;
        const fetchMock = jest.fn(async (_input, init?: RequestInit) => {
            if (init?.method === 'DELETE') return mockJsonResponse({});
            const token =
                postCount++ === 0 ? OPAQUE_TOKEN : SECOND_OPAQUE_TOKEN;
            return mockJsonResponse({
                url: `/api/media/cast/${token}/stream.mp4`,
            });
        });
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(
            document.createElement('video'),
            '/api/media/movie/42.mp4'
        );
        await settlePromises();
        controller.attach(
            document.createElement('video'),
            '/api/media/movie/43.mp4'
        );
        await settlePromises();
        controller.detach();
        await settlePromises();

        const deleteUrls = fetchMock.mock.calls
            .filter(([, init]) => init?.method === 'DELETE')
            .map(([url]) => url);
        expect(deleteUrls).toEqual(
            expect.arrayContaining([
                `http://localhost/api/media/cast/${OPAQUE_TOKEN}`,
                `http://localhost/api/media/cast/${SECOND_OPAQUE_TOKEN}`,
            ])
        );
    });

    it('revokes a prepare response that arrives after its source is stale', async () => {
        const firstResponse = deferred<Response>();
        let postCount = 0;
        const fetchMock = jest.fn((_input, init?: RequestInit) => {
            if (init?.method === 'DELETE') {
                return Promise.resolve(mockJsonResponse({}));
            }
            if (postCount++ === 0) return firstResponse.promise;
            return Promise.resolve(
                mockJsonResponse({
                    url: `/api/media/cast/${SECOND_OPAQUE_TOKEN}/stream.mp4`,
                })
            );
        });
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(
            document.createElement('video'),
            '/api/media/movie/42.mp4'
        );
        controller.attach(
            document.createElement('video'),
            '/api/media/movie/43.mp4'
        );
        await settlePromises();
        firstResponse.resolve(
            mockJsonResponse({
                url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
            })
        );
        await settlePromises();

        expect(fetchMock).toHaveBeenCalledWith(
            `http://localhost/api/media/cast/${OPAQUE_TOKEN}`,
            expect.objectContaining({ method: 'DELETE' })
        );
        expect(controller.state().canPrompt).toBe(true);
        controller.detach();
    });

    it('pauses local playback during casting and restores it without unmuting', async () => {
        const fetchMock = jest.fn(async () =>
            mockJsonResponse({
                url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
            })
        );
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );
        const source = createControllableVideo(false);
        source.currentTime = 12;
        source.muted = false;
        controller.attach(source, '/api/media/movie/42.mp4');
        await settlePromises();
        const remoteVideo = document.querySelector<HTMLVideoElement>(
            'video[aria-hidden="true"]'
        );
        expect(remoteVideo).not.toBeNull();
        const remoteElement = createControllableMethods(
            remoteVideo as HTMLVideoElement,
            true
        );

        remote.state = 'connected';
        remote.dispatchEvent(new Event('connect'));

        expect(source.pause).toHaveBeenCalled();
        expect(source.paused).toBe(true);
        expect(source.muted).toBe(true);
        expect(remoteElement.play).toHaveBeenCalled();
        source.dispatchEvent(new Event('pause'));
        expect(remoteElement.pause).not.toHaveBeenCalled();
        (remoteVideo as HTMLVideoElement).volume = 0.35;
        (remoteVideo as HTMLVideoElement).muted = false;
        remoteVideo?.dispatchEvent(new Event('volumechange'));
        expect(remoteVideo?.volume).toBe(0.35);
        expect(source.muted).toBe(true);

        (remoteVideo as HTMLVideoElement).currentTime = 48;
        remoteVideo?.dispatchEvent(new Event('timeupdate'));
        expect(source.currentTime).toBe(12);
        remote.state = 'disconnected';
        remote.dispatchEvent(new Event('disconnect'));

        expect(source.currentTime).toBe(48);
        expect(source.muted).toBe(false);
        expect(source.play).toHaveBeenCalled();
        expect(source.paused).toBe(false);
        expect(fetchMock).toHaveBeenCalledWith(
            `http://localhost/api/media/cast/${OPAQUE_TOKEN}`,
            expect.objectContaining({ method: 'DELETE' })
        );
        controller.detach();
    });

    it('does not restore a synthetic remote position before position evidence', async () => {
        const fetchMock = jest.fn(async () =>
            mockJsonResponse({
                url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
            })
        );
        const finishRemotePlayback = jest.fn();
        const host = {
            beginRemotePlayback: jest.fn(),
            finishRemotePlayback,
        };
        const source = createControllableVideo(false);
        source.currentTime = 73;
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(source, '/api/media/movie/42.mp4', host);
        await settlePromises();
        const remoteVideo = document.querySelector<HTMLVideoElement>(
            'video[aria-hidden="true"]'
        );
        expect(remoteVideo).not.toBeNull();
        createControllableMethods(remoteVideo as HTMLVideoElement, true);

        remote.state = 'connected';
        remote.dispatchEvent(new Event('connect'));
        expect(host.beginRemotePlayback).toHaveBeenCalledWith(
            remoteVideo,
            expect.objectContaining({ playing: true, positionSeconds: 73 })
        );
        (remoteVideo as HTMLVideoElement).currentTime = 0;
        remote.state = 'disconnected';
        remote.dispatchEvent(new Event('disconnect'));

        expect(finishRemotePlayback).toHaveBeenCalledTimes(1);
        const resumeState = finishRemotePlayback.mock.calls[0][0] as Record<
            string,
            unknown
        >;
        expect(resumeState).not.toHaveProperty('positionSeconds');
        controller.detach();
    });

    it('ignores duplicate disconnect events after preparing a retry ticket', async () => {
        let postCount = 0;
        const fetchMock = jest.fn(async (_input, init?: RequestInit) => {
            if (init?.method === 'DELETE') return mockJsonResponse({});
            const token =
                postCount++ === 0 ? OPAQUE_TOKEN : SECOND_OPAQUE_TOKEN;
            return mockJsonResponse({
                url: `/api/media/cast/${token}/stream.mp4`,
            });
        });
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(
            createControllableVideo(true),
            '/api/media/movie/42.mp4'
        );
        await settlePromises();
        remote.state = 'connected';
        remote.dispatchEvent(new Event('connect'));
        remote.state = 'disconnected';
        remote.dispatchEvent(new Event('disconnect'));
        await settlePromises();
        remote.dispatchEvent(new Event('disconnect'));
        await settlePromises();

        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
        ).toHaveLength(2);
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
        ).toHaveLength(1);
        expect(controller.state().canPrompt).toBe(true);
        controller.detach();
    });

    it('stays hidden when neither Remote Playback nor AirPlay exists', () => {
        Object.defineProperty(HTMLMediaElement.prototype, 'remote', {
            configurable: true,
            get: () => undefined,
        });
        Reflect.deleteProperty(
            HTMLMediaElement.prototype,
            'webkitShowPlaybackTargetPicker'
        );
        const fetchMock = jest.fn();
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(
            document.createElement('video'),
            '/api/media/movie/42.mp4'
        );

        expect(fetchMock).not.toHaveBeenCalled();
        expect(controller.state().supported).toBe(false);
    });

    it('pauses the remote without restoring its host on terminal detach', async () => {
        const fetchMock = jest.fn(async () =>
            mockJsonResponse({
                expiresInSeconds: 900,
                url: `/api/media/cast/${OPAQUE_TOKEN}/stream.mp4`,
            })
        );
        const host = {
            beginRemotePlayback: jest.fn(),
            finishRemotePlayback: jest.fn(),
        };
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );
        const source = document.createElement('video');
        jest.spyOn(source, 'pause').mockImplementation(() => undefined);

        controller.attach(source, '/api/media/movie/42.mp4', host);
        await settlePromises();
        const remoteVideo = document.querySelector<HTMLVideoElement>(
            'video[aria-hidden="true"]'
        );
        expect(remoteVideo).not.toBeNull();
        const pause = jest
            .spyOn(remoteVideo as HTMLVideoElement, 'pause')
            .mockImplementation(() => undefined);
        remote.state = 'connected';
        remote.dispatchEvent(new Event('connect'));
        pause.mockClear();

        controller.detach();

        expect(pause).toHaveBeenCalledTimes(1);
        expect(host.finishRemotePlayback).toHaveBeenCalledWith(
            expect.any(Object),
            false
        );
        expect(remoteVideo?.isConnected).toBe(false);
    });

    it('restores a suspended host before attaching a changed source', async () => {
        let postCount = 0;
        const fetchMock = jest.fn(async (_input, init?: RequestInit) => {
            if (init?.method === 'DELETE') return mockJsonResponse({});
            const token =
                postCount++ === 0 ? OPAQUE_TOKEN : SECOND_OPAQUE_TOKEN;
            return mockJsonResponse({
                expiresInSeconds: 900,
                url: `/api/media/cast/${token}/stream.mp4`,
            });
        });
        let suspended = false;
        const host = {
            beginRemotePlayback: jest.fn(() => {
                suspended = true;
            }),
            finishRemotePlayback: jest.fn(
                (_state: unknown, restoreLocal: boolean) => {
                    if (restoreLocal) suspended = false;
                }
            ),
        };
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(
            createControllableVideo(false),
            '/api/media/movie/42.mp4',
            host
        );
        await settlePromises();
        const firstRemoteVideo = document.querySelector<HTMLVideoElement>(
            'video[aria-hidden="true"]'
        );
        expect(firstRemoteVideo).not.toBeNull();
        createControllableMethods(firstRemoteVideo as HTMLVideoElement, true);

        remote.state = 'connected';
        remote.dispatchEvent(new Event('connect'));
        expect(suspended).toBe(true);
        (firstRemoteVideo as HTMLVideoElement).currentTime = 87;
        firstRemoteVideo?.dispatchEvent(new Event('timeupdate'));

        remote.state = 'disconnected';
        controller.attach(
            createControllableVideo(true),
            '/api/media/movie/43.mp4',
            host
        );
        await settlePromises();

        expect(host.finishRemotePlayback).toHaveBeenCalledTimes(1);
        const [resumeState, restoreLocal] =
            host.finishRemotePlayback.mock.calls[0];
        expect(resumeState).toEqual(
            expect.objectContaining({ playing: true })
        );
        expect(resumeState).not.toHaveProperty('positionSeconds');
        expect(restoreLocal).toBe(true);
        expect(suspended).toBe(false);
        expect(firstRemoteVideo?.isConnected).toBe(false);
        expect(controller.state()).toMatchObject({
            active: false,
            canPrompt: true,
            supported: true,
        });
        controller.detach();
    });

    it('rejects a ticket URL issued by another origin', async () => {
        const fetchMock = jest.fn(async () =>
            mockJsonResponse({
                expiresInSeconds: 900,
                url: 'https://attacker.example/media/cast/token/stream.mp4',
            })
        );
        const controller = new WebVideoRemotePlaybackController(
            fetchMock as typeof fetch
        );

        controller.attach(
            document.createElement('video'),
            '/api/media/movie/42.mp4'
        );
        await settlePromises();

        expect(controller.state().supported).toBe(false);
        expect(document.querySelector('video[aria-hidden="true"]')).toBeNull();
    });
});

async function settlePromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function mockJsonResponse(
    value: unknown,
    options: {
        readonly ok?: boolean;
        readonly retryAfter?: string;
        readonly status?: number;
    } = {}
): Response {
    return {
        headers: new Headers(
            options.retryAfter ? { 'Retry-After': options.retryAfter } : {}
        ),
        json: async () => value,
        ok: options.ok ?? true,
        status: options.status ?? 200,
    } as Response;
}

function createControllableVideo(paused: boolean): HTMLVideoElement {
    const video = document.createElement('video');
    createControllableMethods(video, paused);
    return video;
}

function createControllableMethods(
    video: HTMLVideoElement,
    paused: boolean
): { readonly pause: jest.Mock; readonly play: jest.Mock } {
    Object.defineProperty(video, 'paused', {
        configurable: true,
        value: paused,
        writable: true,
    });
    const play = jest.fn(async () => {
        Reflect.set(video, 'paused', false);
        video.dispatchEvent(new Event('play'));
    });
    const pause = jest.fn(() => {
        const changed = !video.paused;
        Reflect.set(video, 'paused', true);
        if (changed) video.dispatchEvent(new Event('pause'));
    });
    Object.defineProperty(video, 'play', {
        configurable: true,
        value: play,
    });
    Object.defineProperty(video, 'pause', {
        configurable: true,
        value: pause,
    });
    return { pause, play };
}

function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly reject: (reason?: unknown) => void;
    readonly resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, reject, resolve };
}
