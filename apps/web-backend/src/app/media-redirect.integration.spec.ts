import express from 'express';
import { createWebBackendApp } from './web-backend-app';
import {
    registerProviderTarget,
    withServer,
} from './web-backend-app.spec-helpers';

describe('HLS redirects', () => {
    it('resolves nested playlists and segments relative to each final response URL', async () => {
        const provider = express();
        provider.get('/player_api.php', (_req, res) =>
            res.json({
                user_info: { auth: 1, status: 'Active' },
            })
        );
        provider.get('/live/viewer/test/42.m3u8', (_req, res) =>
            res.redirect('/cdn/master.m3u8')
        );
        provider.get('/cdn/master.m3u8', (_req, res) =>
            res
                .type('application/vnd.apple.mpegurl')
                .send(
                    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200\nvariant.m3u8\n'
                )
        );
        provider.get('/cdn/variant.m3u8', (_req, res) =>
            res.redirect('/edge/index.m3u8')
        );
        provider.get('/edge/index.m3u8', (_req, res) =>
            res
                .type('application/vnd.apple.mpegurl')
                .send('#EXTM3U\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n')
        );
        provider.get('/edge/segment.ts', (_req, res) =>
            res.type('video/mp2t').send('test-segment')
        );
        await withServer(provider, async (providerUrl) => {
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
                const login = await fetch(`${backendUrl}/xtream`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        targetId,
                        params: { username: 'viewer', password: 'test' },
                        connectionTest: true,
                    }),
                });
                expect(login.status).toBe(200);
                const cookie = login.headers.getSetCookie()[0].split(';')[0];
                await login.text();
                const get = (path: string) =>
                    fetch(`${backendUrl}${path.replace(/^\/api/, '')}`, {
                        headers: { Cookie: cookie },
                    });
                const master = await get('/media/live/42.m3u8');
                expect(master.status).toBe(200);
                const variantPath = (await master.text())
                    .split('\n')
                    .find((line) => line.startsWith('/api/media/resource/'))!;
                if (!variantPath) throw new Error('Missing variant resource');
                const variant = await get(variantPath);
                expect(variant.status).toBe(200);
                const segmentPath = (await variant.text())
                    .split('\n')
                    .find((line) => line.startsWith('/api/media/resource/'))!;
                if (!segmentPath) throw new Error('Missing segment resource');
                const segment = await get(segmentPath);
                expect(segment.status).toBe(200);
                await expect(segment.text()).resolves.toBe('test-segment');
            });
        });
    });
});
