import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(process.cwd(), 'apps/web/src');
const INDEX = readFileSync(resolve(WEB_ROOT, 'index.html'), 'utf8');
const MANIFEST = JSON.parse(
    readFileSync(resolve(WEB_ROOT, 'manifest.webmanifest'), 'utf8')
) as {
    name: string;
    short_name: string;
    lang: string;
    theme_color: string;
    background_color: string;
    icons: Array<{ src: string; sizes: string; type: string }>;
};

describe('ZenPlay web shell branding', () => {
    it('publishes Spanish ZenPlay metadata with the branded palette', () => {
        expect(INDEX).toContain('<html lang="es">');
        expect(INDEX).toContain('<title>ZenPlay</title>');
        expect(INDEX).toContain('name="theme-color" content="#070b1a"');
        expect(INDEX).toContain('viewport-fit=cover');
        expect(INDEX).toContain('aria-label="Cargando ZenPlay"');

        expect(MANIFEST).toMatchObject({
            name: 'ZenPlay',
            short_name: 'ZenPlay',
            lang: 'es-MX',
            theme_color: '#070b1a',
            background_color: '#070b1a',
        });
    });

    it('uses the available ZenPlay logo for browser and installed app surfaces', () => {
        const logoPath = 'assets/branding/zenplay-logo.png';
        const appleIconPath =
            'assets/branding/zenplay-apple-touch-icon.png';

        expect(INDEX).toContain(`href="${appleIconPath}"`);
        expect(INDEX).toContain(`src="${logoPath}"`);
        expect(MANIFEST.icons).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ sizes: '192x192' }),
                expect.objectContaining({ sizes: '512x512' }),
            ])
        );
        expect(existsSync(resolve(WEB_ROOT, logoPath))).toBe(true);
        expect(existsSync(resolve(WEB_ROOT, appleIconPath))).toBe(true);
        for (const icon of MANIFEST.icons) {
            expect(existsSync(resolve(WEB_ROOT, icon.src))).toBe(true);
        }
    });

    it('keeps the existing content security policy intact', () => {
        expect(INDEX).toContain(
            "default-src 'self'; base-uri 'self'; object-src 'none'; frame-src https://www.youtube-nocookie.com; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' http: https: file: data: blob:; font-src 'self' data:; media-src 'self' http: https: file: data: blob:; connect-src 'self' http: https: ws: wss: blob: data:; worker-src 'self' blob:"
        );
    });
});
