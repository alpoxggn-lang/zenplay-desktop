import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { createWebBackendApp } from './web-backend-app';
import {
    EXPECTED_MEDIA_SOURCE_HEADER,
    MEDIA_SOURCE_HEADER,
} from './media-router';
import { MediaSessionStore } from './media-session-store';
import { RemotePlaybackCapacityError } from './remote-playback-ticket-store';
import {
    registerProviderTarget,
    withServer,
} from './web-backend-app.spec-helpers';

describe('ZenPlay secure media gateway', () => {
    it('issues a hardened session and streams TS with Range and no credential URL', async () => {
        await withProvider(async (providerUrl) => {
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                runtimeBackendUrl: '/api',
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const login = await loginRequest(backendUrl, targetId);
                const cookie = cookiePair(login);
                const loginText = await login.text();
                const issuedCookies = login.headers.getSetCookie();

                expect(login.status).toBe(200);
                expect(issuedCookies).toHaveLength(2);
                expect(issuedCookies[0]).toContain('HttpOnly');
                expect(issuedCookies[0]).toContain('Secure');
                expect(issuedCookies[0]).toContain('SameSite=Strict');
                expect(issuedCookies[0]).toContain('Path=/api;');
                expect(issuedCookies[0]).not.toContain('Max-Age=0');
                expect(issuedCookies[1]).toContain('Path=/api/media;');
                expect(issuedCookies[1]).toContain('Max-Age=0');
                expect(loginText).not.toContain('secret-password');
                expect(cookie).not.toContain('secret-password');

                const browserUrl = `${backendUrl}/media/live/7.ts`;
                expect(browserUrl).not.toContain('viewer');
                expect(browserUrl).not.toContain('secret-password');
                const media = await fetch(browserUrl, {
                    headers: { Cookie: cookie, Range: 'bytes=1-3' },
                });

                expect(media.status).toBe(206);
                expect(media.headers.get('content-range')).toBe('bytes 1-3/6');
                expect(media.headers.get('content-type')).toContain(
                    'video/mp2t'
                );
                expect(media.headers.get('cache-control')).toBe(
                    'private, no-store, no-transform'
                );
                expect(media.headers.get('cdn-cache-control')).toBe('no-store');
                expect(media.headers.get('set-cookie')).toContain('HttpOnly');
                await expect(media.text()).resolves.toBe('234');

                const unsatisfied = await fetch(browserUrl, {
                    headers: {
                        Cookie: cookie,
                        'If-Range': '"current-etag"',
                        Range: 'bytes=99-100',
                    },
                });
                expect(unsatisfied.status).toBe(416);
                expect(unsatisfied.headers.get('content-range')).toBe(
                    'bytes */6'
                );

                const invalidRange = await fetch(browserUrl, {
                    headers: { Cookie: cookie, Range: 'bytes=-' },
                });
                expect(invalidRange.status).toBe(416);

                const logout = await fetch(`${backendUrl}/media/session`, {
                    headers: { Cookie: cookie },
                    method: 'DELETE',
                });
                expect(logout.status).toBe(204);
                const clearedCookies = logout.headers.getSetCookie();
                expect(clearedCookies).toHaveLength(2);
                expect(clearedCookies[0]).toContain('Path=/api;');
                expect(clearedCookies[0]).toContain('Max-Age=0');
                expect(clearedCookies[1]).toContain('Path=/api/media;');
                expect(clearedCookies[1]).toContain('Max-Age=0');
                const revoked = await fetch(browserUrl, {
                    headers: { Cookie: cookie },
                });
                expect(revoked.status).toBe(401);
            });
        });
    });

    it('rewrites every HLS location to session-bound opaque resources', async () => {
        await withProvider(async (providerUrl) => {
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                runtimeBackendUrl: '/api',
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const login = await loginRequest(backendUrl, targetId);
                const cookie = cookiePair(login);
                const manifest = await fetch(
                    `${backendUrl}/media/live/8.m3u8`,
                    { headers: { Cookie: cookie } }
                );
                const body = await manifest.text();

                expect(manifest.status).toBe(200);
                expect(manifest.headers.get('content-type')).toContain(
                    'application/vnd.apple.mpegurl'
                );
                expect(body).not.toContain('viewer');
                expect(body).not.toContain('secret-password');
                expect(body).not.toContain(providerUrl);
                const resources = Array.from(
                    body.matchAll(/\/api\/media\/resource\/[A-Za-z0-9_-]+/g),
                    (match) => match[0]
                );
                expect(resources).toHaveLength(5);

                for (const path of resources) {
                    const resource = await fetch(
                        `${backendUrl}${path.replace(/^\/api/, '')}`,
                        { headers: { Cookie: cookie } }
                    );
                    expect(resource.status).toBe(200);
                    expect(resource.headers.get('cache-control')).toBe(
                        'private, no-store, no-transform'
                    );
                    const resourceBody = await resource.text();
                    expect(resourceBody).not.toContain('secret-password');
                }

                const wrongSession = await fetch(
                    `${backendUrl}${resources[0].replace(/^\/api/, '')}`,
                    { headers: { Cookie: `zenplay_media=${'x'.repeat(43)}` } }
                );
                expect(wrongSession.status).toBe(401);
            });
        });
    });

    it('rejects a stale expected source before contacting the provider', async () => {
        let mediaRequests = 0;
        await withProvider(
            async (providerUrl) => {
                const app = createWebBackendApp({
                    allowPrivateNetworkTargets: true,
                    mediaSourceSecret: 'integration-source-secret',
                    zenPlayXtreamUrl: providerUrl,
                });
                await withServer(app, async (backendUrl) => {
                    const targetId = await registerProviderTarget(
                        backendUrl,
                        providerUrl
                    );
                    const login = await loginRequest(backendUrl, targetId);
                    const mediaUrl = `${backendUrl}/media/live/7.ts`;
                    const valid = await fetch(mediaUrl, {
                        headers: { Cookie: cookiePair(login) },
                    });
                    const sourceId = valid.headers.get(MEDIA_SOURCE_HEADER);

                    expect(valid.status).toBe(200);
                    expect(sourceId).toMatch(/^[A-Za-z0-9_-]{43}$/);
                    expect(mediaRequests).toBe(1);
                    const mismatch = await fetch(mediaUrl, {
                        headers: {
                            Cookie: cookiePair(login),
                            [EXPECTED_MEDIA_SOURCE_HEADER]: 'x'.repeat(43),
                        },
                    });

                    expect(mismatch.status).toBe(409);
                    expect(mismatch.headers.get(MEDIA_SOURCE_HEADER)).toBe(
                        sourceId
                    );
                    expect(mediaRequests).toBe(1);
                });
            },
            undefined,
            (url) => {
                if (url.pathname.endsWith('/7.ts')) mediaRequests += 1;
            }
        );
    });

    it('casts through a short-lived opaque URL without sharing the browser cookie', async () => {
        await withProvider(async (providerUrl) => {
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                runtimeBackendUrl: '/api',
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const login = await loginRequest(backendUrl, targetId);
                const ticketResponse = await fetch(`${backendUrl}/media/cast`, {
                    body: JSON.stringify({
                        adaptive: false,
                        extension: 'm3u8',
                        kind: 'live',
                        streamId: '8',
                    }),
                    headers: {
                        Cookie: cookiePair(login),
                        'content-type': 'application/json',
                    },
                    method: 'POST',
                });
                const ticket = (await ticketResponse.json()) as {
                    expiresInSeconds: number;
                    url: string;
                };

                expect(ticketResponse.status).toBe(201);
                expect(ticket.expiresInSeconds).toBe(900);
                expect(ticket.url).toMatch(
                    /^\/api\/media\/cast\/[A-Za-z0-9_-]+\/stream\.m3u8$/
                );
                expect(ticket.url).not.toContain('viewer');
                expect(ticket.url).not.toContain('secret-password');

                const manifest = await fetch(
                    `${backendUrl}${ticket.url.replace(/^\/api/, '')}`
                );
                const body = await manifest.text();
                expect(manifest.status).toBe(200);
                expect(
                    manifest.headers.get('access-control-allow-origin')
                ).toBe('*');
                expect(body).not.toContain('viewer');
                expect(body).not.toContain('secret-password');
                const resources = Array.from(
                    body.matchAll(
                        /\/api\/media\/cast-resource\/[A-Za-z0-9_-]+/g
                    ),
                    (match) => match[0]
                );
                expect(resources).toHaveLength(5);

                const resource = await fetch(
                    `${backendUrl}${resources[0].replace(/^\/api/, '')}`
                );
                expect(resource.status).toBe(200);
                expect(
                    resource.headers.get('access-control-allow-origin')
                ).toBe('*');
                expect(await resource.text()).not.toContain('secret-password');
            });
        });
    });

    it('returns a retryable response when cast resource capacity is protected', async () => {
        const resourceSpy = jest
            .spyOn(MediaSessionStore.prototype, 'createRemotePlaybackResource')
            .mockImplementation(() => {
                throw new RemotePlaybackCapacityError();
            });
        try {
            await withProvider(async (providerUrl) => {
                const app = createWebBackendApp({
                    allowPrivateNetworkTargets: true,
                    runtimeBackendUrl: '/api',
                    zenPlayXtreamUrl: providerUrl,
                });
                await withServer(app, async (backendUrl) => {
                    const targetId = await registerProviderTarget(
                        backendUrl,
                        providerUrl
                    );
                    const login = await loginRequest(backendUrl, targetId);
                    const ticketResponse = await fetch(
                        `${backendUrl}/media/cast`,
                        {
                            body: JSON.stringify({
                                adaptive: false,
                                extension: 'm3u8',
                                kind: 'live',
                                streamId: '8',
                            }),
                            headers: {
                                Cookie: cookiePair(login),
                                'content-type': 'application/json',
                            },
                            method: 'POST',
                        }
                    );
                    const ticket = (await ticketResponse.json()) as {
                        url: string;
                    };

                    const manifest = await fetch(
                        `${backendUrl}${ticket.url.replace(/^\/api/, '')}`
                    );
                    expect(manifest.status).toBe(429);
                    expect(manifest.headers.get('retry-after')).toBe('60');
                    await expect(manifest.json()).resolves.toMatchObject({
                        status: 429,
                    });
                });
            });
        } finally {
            resourceSpy.mockRestore();
        }
    });

    it('keeps an activated cast URL valid for later Range requests', async () => {
        await withProvider(async (providerUrl) => {
            let timestamp = new Date('2026-01-01T00:00:00Z');
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                now: () => timestamp,
                remotePlaybackTicketTtlMs: 500,
                runtimeBackendUrl: '/api',
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const login = await loginRequest(backendUrl, targetId);
                const ticketResponse = await fetch(`${backendUrl}/media/cast`, {
                    body: JSON.stringify({
                        adaptive: false,
                        extension: 'ts',
                        kind: 'live',
                        streamId: '7',
                    }),
                    headers: {
                        Cookie: cookiePair(login),
                        'content-type': 'application/json',
                    },
                    method: 'POST',
                });
                const ticket = (await ticketResponse.json()) as {
                    url: string;
                };
                const castUrl = `${backendUrl}${ticket.url.replace(
                    /^\/api/,
                    ''
                )}`;
                const first = await fetch(castUrl, {
                    headers: { Range: 'bytes=1-3' },
                });
                expect(first.status).toBe(206);
                await first.arrayBuffer();

                timestamp = new Date(timestamp.getTime() + 901);
                const later = await fetch(castUrl, {
                    headers: { Range: 'bytes=1-3' },
                });
                expect(later.status).toBe(206);
                await expect(later.text()).resolves.toBe('234');
            });
        });
    });

    it('revokes an existing cast when account A is replaced by account B', async () => {
        const mediaPaths: string[] = [];
        await withProvider(
            async (providerUrl) => {
                const app = createWebBackendApp({
                    allowPrivateNetworkTargets: true,
                    runtimeBackendUrl: '/api',
                    zenPlayXtreamUrl: providerUrl,
                });
                await withServer(app, async (backendUrl) => {
                    const targetId = await registerProviderTarget(
                        backendUrl,
                        providerUrl
                    );
                    const firstLogin = await loginRequest(backendUrl, targetId);
                    const ticketResponse = await fetch(
                        `${backendUrl}/media/cast`,
                        {
                            body: JSON.stringify({
                                adaptive: false,
                                extension: 'ts',
                                kind: 'live',
                                streamId: '7',
                            }),
                            headers: {
                                Cookie: cookiePair(firstLogin),
                                'content-type': 'application/json',
                            },
                            method: 'POST',
                        }
                    );
                    const ticket = (await ticketResponse.json()) as {
                        url: string;
                    };
                    const secondLogin = await loginRequest(
                        backendUrl,
                        targetId,
                        'second-password',
                        cookiePair(firstLogin)
                    );
                    expect(secondLogin.status).toBe(200);

                    const oldCast = await fetch(
                        `${backendUrl}${ticket.url.replace(/^\/api/, '')}`,
                        { headers: { Range: 'bytes=1-3' } }
                    );
                    expect(oldCast.status).toBe(410);
                    expect(mediaPaths).toHaveLength(0);
                });
            },
            undefined,
            (url) => {
                if (url.pathname.endsWith('/7.ts')) {
                    mediaPaths.push(url.pathname);
                }
            }
        );
    });

    it('revokes one cast ticket through an authenticated same-origin DELETE', async () => {
        await withProvider(async (providerUrl) => {
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                runtimeBackendUrl: '/api',
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const ownerLogin = await loginRequest(backendUrl, targetId);
                const otherLogin = await loginRequest(backendUrl, targetId);
                const ticketResponse = await fetch(`${backendUrl}/media/cast`, {
                    body: JSON.stringify({
                        adaptive: false,
                        extension: 'ts',
                        kind: 'live',
                        streamId: '7',
                    }),
                    headers: {
                        Cookie: cookiePair(ownerLogin),
                        'content-type': 'application/json',
                    },
                    method: 'POST',
                });
                const ticket = (await ticketResponse.json()) as { url: string };
                const revokeUrl = `${backendUrl}${ticket.url
                    .replace(/^\/api/, '')
                    .replace(/\/stream\.[^/]+$/, '')}`;
                const castUrl = `${backendUrl}${ticket.url.replace(
                    /^\/api/,
                    ''
                )}`;

                const unauthorized = await fetch(revokeUrl, {
                    method: 'DELETE',
                });
                expect(unauthorized.status).toBe(401);
                const wrongSession = await fetch(revokeUrl, {
                    headers: { Cookie: cookiePair(otherLogin) },
                    method: 'DELETE',
                });
                expect(wrongSession.status).toBe(204);
                expect((await fetch(castUrl)).status).toBe(200);

                const revoked = await fetch(revokeUrl, {
                    headers: { Cookie: cookiePair(ownerLogin) },
                    method: 'DELETE',
                });
                expect(revoked.status).toBe(204);
                expect((await fetch(castUrl)).status).toBe(410);
            });
        });
    });

    it('does not activate a cast ticket until its media path is valid', async () => {
        await withProvider(async (providerUrl) => {
            let timestamp = new Date('2026-01-01T00:00:00Z');
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                now: () => timestamp,
                remotePlaybackTicketTtlMs: 500,
                runtimeBackendUrl: '/api',
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const login = await loginRequest(backendUrl, targetId);
                const ticketResponse = await fetch(`${backendUrl}/media/cast`, {
                    body: JSON.stringify({
                        adaptive: false,
                        extension: 'mp4',
                        kind: 'movie',
                        streamId: '7',
                    }),
                    headers: {
                        Cookie: cookiePair(login),
                        'content-type': 'application/json',
                    },
                    method: 'POST',
                });
                const ticket = (await ticketResponse.json()) as { url: string };
                const validUrl = `${backendUrl}${ticket.url.replace(
                    /^\/api/,
                    ''
                )}`;

                expect(
                    (await fetch(validUrl.replace(/\.mp4$/, '.mkv'))).status
                ).toBe(404);
                timestamp = new Date(timestamp.getTime() + 501);
                expect((await fetch(validUrl)).status).toBe(410);
            });
        });
    });

    it('revokes cast tickets when the browser media session logs out', async () => {
        await withProvider(async (providerUrl) => {
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                runtimeBackendUrl: '/api',
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const login = await loginRequest(backendUrl, targetId);
                const cookie = cookiePair(login);
                const ticketResponse = await fetch(`${backendUrl}/media/cast`, {
                    body: JSON.stringify({
                        adaptive: false,
                        extension: 'ts',
                        kind: 'live',
                        streamId: '7',
                    }),
                    headers: {
                        Cookie: cookie,
                        'content-type': 'application/json',
                    },
                    method: 'POST',
                });
                const ticket = (await ticketResponse.json()) as { url: string };
                const castUrl = `${backendUrl}${ticket.url.replace(
                    /^\/api/,
                    ''
                )}`;

                expect(
                    (
                        await fetch(`${backendUrl}/media/session`, {
                            headers: { Cookie: cookie },
                            method: 'DELETE',
                        })
                    ).status
                ).toBe(204);
                expect((await fetch(castUrl)).status).toBe(410);
            });
        });
    });

    it('requires a media session and a strictly validated item to issue a cast URL', async () => {
        await withProvider(async (providerUrl) => {
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                runtimeBackendUrl: '/api',
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const withoutSession = await fetch(`${backendUrl}/media/cast`, {
                    body: JSON.stringify({
                        extension: 'mp4',
                        kind: 'movie',
                        streamId: '1',
                    }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                });
                expect(withoutSession.status).toBe(401);

                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const login = await loginRequest(backendUrl, targetId);
                const invalid = await fetch(`${backendUrl}/media/cast`, {
                    body: JSON.stringify({
                        extension: '../../player_api.php',
                        kind: 'movie',
                        streamId: '1',
                    }),
                    headers: {
                        Cookie: cookiePair(login),
                        'content-type': 'application/json',
                    },
                    method: 'POST',
                });
                expect(invalid.status).toBe(400);
            });
        });
    });

    it('converges concurrent refreshes carrying one stale media cookie', async () => {
        await withProvider(async (providerUrl) => {
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                runtimeBackendUrl: '/api',
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const staleCookie = `zenplay_media=${'s'.repeat(43)}`;
                const [first, concurrent] = await Promise.all([
                    loginRequest(
                        backendUrl,
                        targetId,
                        'secret-password',
                        staleCookie
                    ),
                    loginRequest(
                        backendUrl,
                        targetId,
                        'secret-password',
                        staleCookie
                    ),
                ]);

                expect(cookiePair(concurrent)).toBe(cookiePair(first));
                const media = await fetch(`${backendUrl}/media/live/7.ts`, {
                    headers: { Cookie: staleCookie },
                });
                expect(media.status).toBe(200);
                await expect(media.text()).resolves.toBe('123456');
            });
        });
    });

    it('reuses the media session when an account refresh carries its API cookie', async () => {
        await withProvider(async (providerUrl) => {
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                runtimeBackendUrl: '/api',
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const first = await loginRequest(backendUrl, targetId);
                const cookie = cookiePair(first);
                const refreshed = await loginRequest(
                    backendUrl,
                    targetId,
                    'secret-password',
                    cookie
                );

                expect(refreshed.headers.get('set-cookie')).toContain(
                    'Path=/api'
                );
                expect(cookiePair(refreshed)).toBe(cookie);

                const media = await fetch(`${backendUrl}/media/live/7.ts`, {
                    headers: { Cookie: cookiePair(refreshed) },
                });
                expect(media.status).toBe(200);
                await expect(media.text()).resolves.toBe('123456');
            });
        });
    });

    it('does not create a media session for rejected credentials', async () => {
        await withProvider(async (providerUrl) => {
            const app = createWebBackendApp({
                allowPrivateNetworkTargets: true,
                zenPlayXtreamUrl: providerUrl,
            });
            await withServer(app, async (backendUrl) => {
                const targetId = await registerProviderTarget(
                    backendUrl,
                    providerUrl
                );
                const login = await loginRequest(
                    backendUrl,
                    targetId,
                    'wrong-password'
                );

                expect(login.headers.get('set-cookie')).toBeNull();
                const body = await login.text();
                expect(body).not.toContain('wrong-password');
            });
        });
    });

    it('expires an idle session and aborts upstream when the viewer disconnects', async () => {
        let providerClosed = false;
        await withProvider(
            async (providerUrl) => {
                let timestamp = new Date('2026-01-01T00:00:00Z');
                const app = createWebBackendApp({
                    allowPrivateNetworkTargets: true,
                    mediaSessionTtlMs: 1_000,
                    now: () => timestamp,
                    zenPlayXtreamUrl: providerUrl,
                });
                await withServer(app, async (backendUrl) => {
                    const targetId = await registerProviderTarget(
                        backendUrl,
                        providerUrl
                    );
                    const firstLogin = await loginRequest(backendUrl, targetId);
                    const expiredCookie = cookiePair(firstLogin);
                    timestamp = new Date(timestamp.getTime() + 1_001);
                    const expired = await fetch(
                        `${backendUrl}/media/live/7.ts`,
                        { headers: { Cookie: expiredCookie } }
                    );
                    expect(expired.status).toBe(401);

                    const activeLogin = await loginRequest(
                        backendUrl,
                        targetId
                    );
                    const controller = new AbortController();
                    const response = await fetch(
                        `${backendUrl}/media/live/9.ts`,
                        {
                            headers: { Cookie: cookiePair(activeLogin) },
                            signal: controller.signal,
                        }
                    );
                    await response.body?.getReader().read();
                    controller.abort();
                    await waitFor(() => providerClosed);
                });
            },
            () => {
                providerClosed = true;
            }
        );
    });
});

async function loginRequest(
    backendUrl: string,
    targetId: string,
    password = 'secret-password',
    cookie?: string
): Promise<Response> {
    return fetch(`${backendUrl}/xtream`, {
        body: JSON.stringify({
            targetId,
            params: { username: 'viewer', password },
            connectionTest: true,
        }),
        headers: {
            'content-type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
        },
        method: 'POST',
    });
}

function cookiePair(response: Response): string {
    const value =
        response.headers.getSetCookie()[0] ??
        response.headers.get('set-cookie');
    if (!value) throw new Error('Expected media session cookie');
    return value.split(';', 1)[0];
}

async function withProvider(
    callback: (providerUrl: string) => Promise<void>,
    onSlowClose?: () => void,
    onRequest?: (url: URL) => void
): Promise<void> {
    let providerUrl = '';
    const server = createServer((req, res) =>
        providerResponse(req, res, providerUrl, onSlowClose, onRequest)
    );
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address() as AddressInfo;
    providerUrl = `http://127.0.0.1:${address.port}`;
    try {
        await callback(providerUrl);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        );
    }
}

function providerResponse(
    req: IncomingMessage,
    res: ServerResponse,
    providerUrl: string,
    onSlowClose?: () => void,
    onRequest?: (url: URL) => void
): void {
    const url = new URL(req.url ?? '/', providerUrl);
    onRequest?.(url);
    if (url.pathname.endsWith('/player_api.php')) {
        const password = url.searchParams.get('password');
        const authorized =
            password === 'secret-password' || password === 'second-password';
        res.setHeader('content-type', 'application/json');
        res.end(
            JSON.stringify({
                user_info: {
                    auth: authorized ? 1 : 0,
                    password,
                    status: authorized ? 'Active' : 'Disabled',
                    username: url.searchParams.get('username'),
                },
            })
        );
        return;
    }
    if (url.pathname.endsWith('/7.ts')) {
        const payload = Buffer.from('123456');
        if (req.headers.range === 'bytes=1-3') {
            res.statusCode = 206;
            res.setHeader('content-range', 'bytes 1-3/6');
            res.setHeader('content-length', '3');
            res.setHeader('accept-ranges', 'bytes');
            res.setHeader('content-type', 'video/mp2t');
            res.end(payload.subarray(1, 4));
            return;
        }
        if (
            req.headers.range === 'bytes=99-100' &&
            req.headers['if-range'] === '"current-etag"'
        ) {
            res.statusCode = 416;
            res.setHeader('content-range', 'bytes */6');
            res.end();
            return;
        }
        res.setHeader('content-type', 'video/mp2t');
        res.end(payload);
        return;
    }
    if (url.pathname.endsWith('/8.m3u8')) {
        res.setHeader('content-type', 'application/vnd.apple.mpegurl');
        res.end(
            [
                '#EXTM3U',
                '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
                '#EXT-X-MAP:URI="/init.mp4"',
                '#EXT-X-MEDIA:TYPE=AUDIO,URI=audio.m3u8',
                '#EXTINF:6,',
                'segment.ts',
                '#EXT-X-STREAM-INF:BANDWIDTH=1200',
                `${providerUrl}/live/viewer/secret-password/variant.m3u8`,
                '',
            ].join('\n')
        );
        return;
    }
    if (url.pathname.endsWith('/9.ts')) {
        res.setHeader('content-type', 'video/mp2t');
        const timer = setInterval(() => res.write(Buffer.alloc(1024)), 10);
        const close = () => {
            clearInterval(timer);
            onSlowClose?.();
        };
        req.once('close', close);
        res.once('close', close);
        res.write(Buffer.alloc(1024));
        return;
    }
    if (url.pathname.endsWith('.m3u8')) {
        res.setHeader('content-type', 'application/vnd.apple.mpegurl');
        res.end('#EXTM3U\n#EXTINF:6,\nleaf.ts\n');
        return;
    }
    res.setHeader('content-type', 'application/octet-stream');
    res.end('resource');
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for provider disconnect');
}
