import { rewriteHlsManifest } from './media-manifest';

describe('rewriteHlsManifest', () => {
    it('tokenizes relative, absolute, map, key, and media URIs', () => {
        const source = [
            '#EXTM3U',
            '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin?password=hidden"',
            '#EXT-X-MAP:URI="/init.mp4"',
            '#EXT-X-MEDIA:TYPE=AUDIO,URI=audio/index.m3u8',
            '#EXTINF:6,',
            'segments/one.ts?username=viewer',
            '#EXT-X-STREAM-INF:BANDWIDTH=1000',
            'https://cdn.example/variant.m3u8?token=provider-secret',
            '',
        ].join('\n');
        const resolved: string[] = [];
        const result = rewriteHlsManifest({
            body: source,
            manifestUrl: new URL(
                'https://provider.example/live/viewer/hidden/main.m3u8'
            ),
            resourcePath: (url) => {
                resolved.push(url.href);
                return `/api/media/resource/token-${resolved.length}`;
            },
        });

        expect(resolved).toHaveLength(5);
        expect(resolved[0]).toBe(
            'https://provider.example/live/viewer/hidden/keys/key.bin?password=hidden'
        );
        expect(resolved[1]).toBe('https://provider.example/init.mp4');
        expect(result).not.toContain('viewer');
        expect(result).not.toContain('hidden');
        expect(result).not.toContain('provider-secret');
        expect(result.match(/\/api\/media\/resource\/token-/g)).toHaveLength(5);
    });
});
