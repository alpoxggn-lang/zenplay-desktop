import { createWebBackendApp } from './web-backend-app';
import { XTREAM_CLIENT_USER_AGENT } from '@iptvnator/shared/interfaces';
import {
    registerProviderTarget,
    resolvePublicHost,
    StubHttpClient,
    withServer,
} from './web-backend-app.spec-helpers';

describe('web backend Xtream POST transport', () => {
    it('disables credential-bearing GET only for managed deployments while keeping POST available', async () => {
        const httpClient = new StubHttpClient();
        httpClient.queueResponse({ user_info: { username: 'demo' } });
        const managedUrl = 'https://xtream.example/panel';

        await withServer(
            createWebBackendApp({
                disableXtreamGet: true,
                httpClient,
                resolveHostname: resolvePublicHost,
                zenPlayXtreamUrl: managedUrl,
            }),
            async (baseUrl) => {
                const targetId = await registerProviderTarget(
                    baseUrl,
                    managedUrl
                );
                const getResponse = await fetch(
                    `${baseUrl}/xtream?targetId=${targetId}&username=demo&password=secret`
                );

                expect(getResponse.status).toBe(405);
                expect(getResponse.headers.get('allow')).toBe('POST, OPTIONS');
                await expect(getResponse.json()).resolves.toEqual({
                    message: 'Xtream GET is disabled; use POST',
                    status: 405,
                });
                expect(httpClient.requests).toEqual([]);

                const postResponse = await fetch(`${baseUrl}/xtream`, {
                    body: JSON.stringify({
                        targetId,
                        params: {
                            action: 'get_account_info',
                            password: 'secret',
                            username: 'demo',
                        },
                    }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                });

                expect(postResponse.status).toBe(200);
                await expect(postResponse.json()).resolves.toEqual({
                    action: 'get_account_info',
                    payload: { user_info: { username: 'demo' } },
                });
                expect(httpClient.requests).toHaveLength(1);
            }
        );
    });

    it('keeps Xtream credentials out of the backend request URL', async () => {
        const httpClient = new StubHttpClient();
        httpClient.queueResponse({ user_info: { username: 'demo' } });

        await withServer(
            createWebBackendApp({
                httpClient,
                resolveHostname: resolvePublicHost,
            }),
            async (baseUrl) => {
                const targetId = await registerProviderTarget(
                    baseUrl,
                    'https://xtream.example/panel'
                );
                const response = await fetch(`${baseUrl}/xtream`, {
                    body: JSON.stringify({
                        targetId,
                        params: {
                            action: 'get_account_info',
                            password: 'secret',
                            username: 'demo',
                        },
                    }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                });

                expect(response.status).toBe(200);
                await expect(response.json()).resolves.toEqual({
                    action: 'get_account_info',
                    payload: { user_info: { username: 'demo' } },
                });
                expect(httpClient.requests).toEqual([
                    {
                        headers: {
                            Accept: 'application/json',
                            'User-Agent': XTREAM_CLIENT_USER_AGENT,
                        },
                        params: {
                            action: 'get_account_info',
                            password: 'secret',
                            username: 'demo',
                        },
                        timeout: 30000,
                        url: 'https://xtream.example/panel/player_api.php',
                    },
                ]);
            }
        );
    });

    it('rejects malformed POST bodies without contacting the provider', async () => {
        const httpClient = new StubHttpClient();

        await withServer(
            createWebBackendApp({ httpClient }),
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/xtream`, {
                    body: JSON.stringify({
                        targetId: 'target',
                        params: { password: 123 },
                    }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                });

                expect(response.status).toBe(400);
                await expect(response.json()).resolves.toEqual({
                    message: 'Expected { targetId, params, connectionTest? }',
                    status: 400,
                });
                expect(httpClient.requests).toEqual([]);
            }
        );
    });
});
