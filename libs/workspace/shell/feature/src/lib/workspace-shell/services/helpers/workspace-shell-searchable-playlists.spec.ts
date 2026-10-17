import { isWorkspaceGlobalSearchablePlaylist } from './workspace-shell-searchable-playlists';

describe('isWorkspaceGlobalSearchablePlaylist', () => {
    it('excludes Stalker sources even when they also expose a server URL', () => {
        expect(
            isWorkspaceGlobalSearchablePlaylist({
                count: 0,
                serverUrl: 'https://stalker.example.test',
                macAddress: '00:1A:79:00:00:01',
            })
        ).toBe(false);
    });

    it('keeps Xtream and M3U sources searchable', () => {
        expect(
            isWorkspaceGlobalSearchablePlaylist({
                count: 0,
                serverUrl: 'https://xtream.example.test',
            })
        ).toBe(true);
        expect(
            isWorkspaceGlobalSearchablePlaylist({
                count: 0,
                url: 'https://example.test/channels.m3u',
            })
        ).toBe(true);
    });
});
