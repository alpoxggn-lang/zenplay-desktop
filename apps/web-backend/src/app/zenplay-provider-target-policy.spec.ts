import {
    isZenPlayProviderTargetAllowed,
    ZENPLAY_PROVIDER_NOT_ALLOWED,
} from './zenplay-provider-target-policy';
import { createWebBackendApp } from './web-backend-app';
import {
    resolvePublicHost,
    StubHttpClient,
    withServer,
} from './web-backend-app.spec-helpers';

describe('ZenPlay provider target policy', () => {
    const managedUrl = 'https://zenplay.example:8443/portal/';

    it('keeps ordinary self-hosted deployments unrestricted when unset', () => {
        expect(
            isZenPlayProviderTargetAllowed(undefined, 'https://other.example')
        ).toBe(true);
        expect(
            isZenPlayProviderTargetAllowed('  ', 'https://other.example')
        ).toBe(true);
    });

    it('accepts only the normalized configured Xtream endpoint', () => {
        expect(
            isZenPlayProviderTargetAllowed(
                managedUrl,
                'https://zenplay.example:8443/portal/player_api.php?username=u&password=p'
            )
        ).toBe(true);
        expect(
            isZenPlayProviderTargetAllowed(
                managedUrl,
                'https://zenplay.example:8443/other'
            )
        ).toBe(false);
        expect(
            isZenPlayProviderTargetAllowed(
                managedUrl,
                'http://zenplay.example:8443/portal'
            )
        ).toBe(false);
        expect(
            isZenPlayProviderTargetAllowed(managedUrl, 'https://other.example')
        ).toBe(false);
    });

    it('fails closed when the managed URL is invalid', () => {
        expect(isZenPlayProviderTargetAllowed('not a URL', managedUrl)).toBe(
            false
        );
    });

    it('rejects an unapproved registration before DNS or transport work', async () => {
        const resolveHostname = jest.fn(resolvePublicHost);
        const httpClient = new StubHttpClient();

        await withServer(
            createWebBackendApp({
                httpClient,
                resolveHostname,
                zenPlayXtreamUrl: managedUrl,
            }),
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/provider-targets`, {
                    body: JSON.stringify({ url: 'https://other.example' }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                });

                expect(response.status).toBe(403);
                await expect(response.json()).resolves.toEqual(
                    ZENPLAY_PROVIDER_NOT_ALLOWED
                );
                expect(resolveHostname).not.toHaveBeenCalled();
                expect(httpClient.requests).toEqual([]);
            }
        );
    });

    it('registers the configured endpoint after normal URL validation', async () => {
        await withServer(
            createWebBackendApp({
                resolveHostname: resolvePublicHost,
                zenPlayXtreamUrl: managedUrl,
            }),
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/provider-targets`, {
                    body: JSON.stringify({
                        url: 'https://zenplay.example:8443/portal/player_api.php',
                    }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                });

                expect(response.status).toBe(200);
                await expect(response.json()).resolves.toEqual({
                    targetId: expect.any(String),
                });
            }
        );
    });
});
