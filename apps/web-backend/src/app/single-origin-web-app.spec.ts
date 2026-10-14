import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSingleOriginWebApp } from './single-origin-web-app';
import { createWebBackendApp } from './web-backend-app';
import { withServer } from './web-backend-app.spec-helpers';

describe('single-origin ZenPlay PWA gateway', () => {
    let staticDirectory: string;

    beforeEach(() => {
        staticDirectory = mkdtempSync(join(tmpdir(), 'zenplay-pwa-'));
        writeFileSync(
            join(staticDirectory, 'index.html'),
            '<!doctype html><title>ZenPlay</title>'
        );
        writeFileSync(join(staticDirectory, 'main.js'), 'window.ZenPlay=true;');
    });

    afterEach(() => {
        rmSync(staticDirectory, { force: true, recursive: true });
    });

    it('serves the PWA and backend health check from one origin', async () => {
        const app = createSingleOriginWebApp({
            backend: createWebBackendApp({ storage: null }),
            staticDirectory,
        });

        await withServer(app, async (baseUrl) => {
            const health = await fetch(`${baseUrl}/api/health`);
            expect(health.status).toBe(200);
            await expect(health.json()).resolves.toEqual({
                service: 'iptvnator-web-backend',
                status: 'ok',
            });

            const asset = await fetch(`${baseUrl}/main.js`);
            await expect(asset.text()).resolves.toBe('window.ZenPlay=true;');

            const route = await fetch(`${baseUrl}/workspace/xtreams/demo`);
            expect(route.headers.get('cache-control')).toBe('no-cache');
            await expect(route.text()).resolves.toContain('<title>ZenPlay');
        });
    });

    it('does not turn missing API routes into the PWA shell', async () => {
        const app = createSingleOriginWebApp({
            backend: createWebBackendApp({ storage: null }),
            staticDirectory,
        });

        await withServer(app, async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/missing`);
            expect(response.status).toBe(404);
            await expect(response.json()).resolves.toEqual({
                message: 'API route not found',
                status: 404,
            });
        });
    });
});
