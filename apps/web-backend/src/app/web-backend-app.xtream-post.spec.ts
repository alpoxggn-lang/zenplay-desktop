import { createWebBackendApp } from './web-backend-app';
import {
    registerProviderTarget,
    resolvePublicHost,
    StubHttpClient,
    withServer,
} from './web-backend-app.spec-helpers';

describe('web backend Xtream POST transport', () => {
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
                        headers: undefined,
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
