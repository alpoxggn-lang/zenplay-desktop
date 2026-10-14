import { findPreferredSpanishAudioTrackIndex } from './preferred-audio-track';

describe('findPreferredSpanishAudioTrackIndex', () => {
    it.each([
        [{ language: 'es' }],
        [{ language: 'es-MX' }],
        [{ lang: 'spa' }],
        [{ lang: 'ESP' }],
        [{ label: 'Español Latino 5.1' }],
        [{ label: 'Castellano' }],
        [{ name: 'Spanish' }],
        [{ name: 'Audio LATAM' }],
    ])('recognizes an explicitly Spanish track: %j', (track) => {
        expect(findPreferredSpanishAudioTrackIndex([track])).toBe(0);
    });

    it('returns the first Spanish track without reordering the source list', () => {
        expect(
            findPreferredSpanishAudioTrackIndex([
                { language: 'en', label: 'English' },
                { language: 'es-419', label: 'Español latino' },
                { language: 'es-ES', label: 'Castellano' },
            ])
        ).toBe(1);
    });

    it.each([
        'Español - comentarios del director',
        'Spanish commentary',
        'Español audiodescripción',
        'Spanish audio description',
    ])('prefers main Spanish over the alternate track %s', (alternate) => {
        expect(
            findPreferredSpanishAudioTrackIndex([
                { language: 'es', label: alternate },
                { language: 'es-MX', label: 'Español Latino 5.1' },
            ])
        ).toBe(1);
    });

    it('uses engine roles to avoid a Spanish commentary track', () => {
        expect(
            findPreferredSpanishAudioTrackIndex([
                { language: 'es', label: 'Español', roles: ['commentary'] },
                { language: 'es-MX', label: 'Español Latino', roles: [] },
            ])
        ).toBe(1);
    });

    it('still returns described/commentary Spanish when it is the only Spanish track', () => {
        expect(
            findPreferredSpanishAudioTrackIndex([
                { language: 'en', label: 'English' },
                {
                    language: 'es',
                    kind: 'descriptions',
                    label: 'Español audiodescripción',
                },
            ])
        ).toBe(1);
    });

    it.each([
        undefined,
        null,
        [],
        [{ language: 'en', label: 'English' }],
        [{ language: 'en', label: 'Inglés' }],
        [{ language: 'und', label: 'Audio 1' }],
        [{ language: 42, label: null, name: false }],
    ])('does not invent a Spanish track from %j', (tracks) => {
        expect(findPreferredSpanishAudioTrackIndex(tracks)).toBe(-1);
    });
});
