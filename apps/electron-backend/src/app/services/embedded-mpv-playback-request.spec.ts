import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';
import { normalizeEmbeddedMpvPlaybackRequest } from './embedded-mpv-playback-request';

const BASE_PLAYBACK: ResolvedPortalPlayback = {
    streamUrl: 'https://media.example/movie/42.mkv',
    title: 'Movie',
};

describe('normalizeEmbeddedMpvPlaybackRequest', () => {
    it('adds the dedicated portal origin to the libmpv header map', () => {
        expect(
            normalizeEmbeddedMpvPlaybackRequest({
                ...BASE_PLAYBACK,
                origin: ' https://portal.example ',
                headers: { Authorization: 'Bearer secret' },
            })
        ).toEqual({
            ...BASE_PLAYBACK,
            origin: ' https://portal.example ',
            headers: {
                Authorization: 'Bearer secret',
                Origin: 'https://portal.example',
            },
        });
    });

    it.each(['Origin', 'origin', 'ORIGIN'])(
        'preserves an explicit %s header instead of duplicating it',
        (headerName) => {
            const playback = {
                ...BASE_PLAYBACK,
                origin: 'https://portal.example',
                headers: { [headerName]: 'https://override.example' },
            };

            expect(normalizeEmbeddedMpvPlaybackRequest(playback)).toBe(
                playback
            );
        }
    );

    it('returns the original request when no origin was supplied', () => {
        expect(normalizeEmbeddedMpvPlaybackRequest(BASE_PLAYBACK)).toBe(
            BASE_PLAYBACK
        );
    });
});
