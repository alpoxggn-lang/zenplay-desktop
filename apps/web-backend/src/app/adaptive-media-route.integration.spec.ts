import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    AdaptiveMediaGateway,
    AdaptiveMediaRequest,
} from './adaptive-media-manager';
import { mountAdaptiveMediaRoute } from './adaptive-media-route';
import { MediaSessionStore } from './media-session-store';
import { withServer } from './web-backend-app.spec-helpers';

describe('adaptive media route', () => {
    let directory = '';
    let store: MediaSessionStore;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'zenplay-adaptive-route-'));
        store = new MediaSessionStore();
    });

    afterEach(async () => {
        store.close();
        await rm(directory, { force: true, recursive: true });
    });

    it('authenticates the session and serves an opaque adaptive file', async () => {
        const target = join(directory, 'master.m3u8');
        await writeFile(target, '#EXTM3U\nvideo.m3u8\n');
        let captured: AdaptiveMediaRequest | undefined;
        const gateway: AdaptiveMediaGateway = {
            async getFile(request) {
                captured = request;
                return target;
            },
            revokeSession: jest.fn(),
        };
        const session = store.issue({
            password: 'secret-password',
            targetBaseUrl: 'https://provider.example/base',
            username: 'viewer',
        });
        const app = express();
        mountAdaptiveMediaRoute(app, {
            corsMiddleware: (_req, _res, next) => next(),
            gateway,
            secureCookie: false,
            store,
        });

        await withServer(app, async (url) => {
            const response = await fetch(
                `${url}/media/adaptive/series/910850.mkv/master.m3u8`,
                { headers: { Cookie: `zenplay_media=${session.id}` } }
            );
            expect(response.status).toBe(200);
            await expect(response.text()).resolves.toBe(
                '#EXTM3U\nvideo.m3u8\n'
            );
            expect(response.headers.get('cache-control')).toBe(
                'private, no-store, no-transform'
            );
        });

        expect(captured).toMatchObject({
            extension: 'mkv',
            file: 'master.m3u8',
            kind: 'series',
            streamId: '910850',
        });
        expect(captured?.sourceUrl.href).toBe(
            'https://provider.example/base/series/viewer/secret-password/910850.mkv'
        );
    });

    it('rejects unauthenticated and traversal-like requests', async () => {
        const gateway: AdaptiveMediaGateway = {
            getFile: jest.fn(),
            revokeSession: jest.fn(),
        };
        const app = express();
        mountAdaptiveMediaRoute(app, {
            corsMiddleware: (_req, _res, next) => next(),
            gateway,
            secureCookie: false,
            store,
        });
        const session = store.issue({
            password: 'secret-password',
            targetBaseUrl: 'https://provider.example',
            username: 'viewer',
        });

        await withServer(app, async (url) => {
            const unauthorized = await fetch(
                `${url}/media/adaptive/movie/1.mkv/master.m3u8`
            );
            expect(unauthorized.status).toBe(401);
            const invalid = await fetch(
                `${url}/media/adaptive/movie/1.mkv/not-generated.txt`,
                { headers: { Cookie: `zenplay_media=${session.id}` } }
            );
            expect(invalid.status).toBe(400);
        });

        expect(gateway.getFile).not.toHaveBeenCalled();
    });
});
