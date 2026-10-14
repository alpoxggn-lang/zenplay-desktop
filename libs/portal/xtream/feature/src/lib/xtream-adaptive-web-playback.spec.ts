import {
    resolveXtreamWebPlaybackUrl,
    withXtreamAdaptiveWebPlayback,
    withXtreamDirectWebPlayback,
} from './xtream-adaptive-web-playback';

describe('resolveXtreamWebPlaybackUrl', () => {
    it('routes PWA series MKV playback through authenticated adaptive HLS', () => {
        expect(
            resolveXtreamWebPlaybackUrl('/api/media/series/910850.mkv')
        ).toEqual({
            streamUrl: '/api/media/adaptive/series/910850.mkv/master.m3u8',
            webDirectFallbackUrl: '/api/media/series/910850.mkv',
        });
    });

    it('supports an absolute or custom backend base and normalizes MKV case', () => {
        expect(
            resolveXtreamWebPlaybackUrl(
                'https://zenplay.test/backend/media/movie/42.MKV'
            )
        ).toEqual({
            streamUrl:
                'https://zenplay.test/backend/media/adaptive/movie/42.mkv/master.m3u8',
            webDirectFallbackUrl:
                'https://zenplay.test/backend/media/movie/42.MKV',
        });
    });

    it.each([
        '/api/media/movie/42.mp4',
        'https://provider.test/series/user/password/42.mkv',
    ])('keeps non-adaptive playback direct: %s', (url) => {
        expect(resolveXtreamWebPlaybackUrl(url)).toEqual({
            streamUrl: url,
        });
    });

    it('adapts inline playback while preserving a direct external source', () => {
        const direct = {
            streamUrl: '/api/media/movie/42.mkv',
            title: 'Película',
        };
        const adaptive = withXtreamAdaptiveWebPlayback(direct);

        expect(adaptive).toEqual({
            ...direct,
            streamUrl: '/api/media/adaptive/movie/42.mkv/master.m3u8',
            webDirectFallbackUrl: direct.streamUrl,
        });
        expect(withXtreamDirectWebPlayback(adaptive)).toEqual({
            ...direct,
            webDirectFallbackUrl: undefined,
        });
    });
});
