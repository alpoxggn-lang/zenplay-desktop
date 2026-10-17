import { PlaylistMeta } from '@iptvnator/shared/interfaces';

type SearchablePlaylistMeta = Pick<
    PlaylistMeta,
    'count' | 'filePath' | 'macAddress' | 'serverUrl' | 'url'
>;

export function isWorkspaceGlobalSearchablePlaylist(
    playlist: SearchablePlaylistMeta
): boolean {
    if (playlist.macAddress) {
        return false;
    }

    if (playlist.serverUrl) {
        return true;
    }

    return Boolean(
        playlist.filePath || playlist.url || Number(playlist.count ?? 0) > 0
    );
}
