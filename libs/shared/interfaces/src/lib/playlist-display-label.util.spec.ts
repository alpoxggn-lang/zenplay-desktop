import {
    playlistDisplayLabel,
    playlistNameHasCredentials,
} from './playlist-display-label.util';

describe('playlistDisplayLabel', () => {
    it('collapses a credential-bearing URL to its host', () => {
        expect(
            playlistDisplayLabel(
                'http://provider-a.example:8080/get.php?username=fixture%3Auser&password=fixturePassA&type=m3u_plus'
            )
        ).toBe('provider-a.example:8080');
    });

    it('strips credentials typed outside the URL', () => {
        // The default :80 is dropped by URL normalization, which reads better
        // anyway; a non-default port is kept (see the case above).
        expect(
            playlistDisplayLabel(
                'http://provider-b.example:80 usr== fixtureUserB pas=== fixturePassB'
            )
        ).toBe('provider-b.example');
    });

    it('keeps a name the user actually chose', () => {
        expect(playlistDisplayLabel('DE movies/kinder')).toBe(
            'DE movies/kinder'
        );
        expect(playlistDisplayLabel('cord-cutter')).toBe('cord-cutter');
    });

    it('removes hand-typed credentials from a non-URL name', () => {
        expect(
            playlistDisplayLabel('MyPortal Username: abc Password: s3cret')
        ).toBe('MyPortal');
    });

    it('never renders a password fragment', () => {
        const labels = [
            'http://provider-c.example:80/get.php?username=fixtureUserC&password=fixturePassC',
            'Portal user==fixtureUserC pass==fixturePassC',
            'http://203.0.113.42 USERNAME : fixtureUserD PASSWORD : fixturePassD',
        ].map((n) => playlistDisplayLabel(n));

        for (const label of labels) {
            expect(label).not.toMatch(
                /fixturePassC|fixturePassD|fixtureUserD/
            );
        }
    });

    it('truncates an over-long name', () => {
        const label = playlistDisplayLabel('a'.repeat(120));
        expect(label.length).toBeLessThanOrEqual(42);
        expect(label.endsWith('…')).toBe(true);
    });

    it('falls back when there is nothing to show', () => {
        expect(playlistDisplayLabel('', 'playlist-1')).toBe('playlist-1');
        expect(playlistDisplayLabel(null, 'playlist-1')).toBe('playlist-1');
        expect(playlistDisplayLabel(undefined)).toBe('');
    });

    it('does not return an empty label for a credentials-only name', () => {
        expect(playlistDisplayLabel('username=fixtureUser password=x')).toBe(
            'Playlist'
        );
    });
});

describe('playlistNameHasCredentials', () => {
    it('detects query-string credentials', () => {
        expect(
            playlistNameHasCredentials(
                'http://provider-c.example/get.php?username=fixtureUser&password=fixturePass'
            )
        ).toBe(true);
    });

    it('detects hand-typed credentials', () => {
        expect(playlistNameHasCredentials('Portal usr== abc pas== def')).toBe(
            true
        );
    });

    it('is false for an ordinary name', () => {
        expect(playlistNameHasCredentials('cord-cutter')).toBe(false);
        expect(playlistNameHasCredentials('http://plain.example:8080')).toBe(
            false
        );
    });
});
