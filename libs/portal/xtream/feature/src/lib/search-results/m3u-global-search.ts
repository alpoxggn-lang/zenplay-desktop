import {
    Channel,
    foldSearchText,
    GLOBAL_SEARCH_CONTENT_TYPES,
    GLOBAL_SEARCH_RESULT_SOURCES,
    M3uGlobalSearchResult,
    Playlist,
    PlaylistMeta,
} from '@iptvnator/shared/interfaces';

export function readM3uChannels(playlist: Partial<Playlist>): Channel[] {
    const nestedPlaylist = playlist.playlist as
        { items?: unknown[] } | undefined;
    const items = Array.isArray(nestedPlaylist?.items)
        ? nestedPlaylist.items
        : Array.isArray(playlist.items)
          ? playlist.items
          : [];

    return items
        .map(normalizeM3uChannel)
        .filter((channel): channel is Channel => channel !== null);
}

export function scoreM3uChannel(channel: Channel, term: string): number | null {
    const scores = [channel.name, channel.tvg.name, channel.group.title]
        .map((value) => scoreText(value, term))
        .filter((score): score is number => score !== null);
    return scores.length > 0 ? Math.min(...scores) : null;
}

export function toM3uGlobalSearchResult(
    playlist: PlaylistMeta,
    channel: Channel
): M3uGlobalSearchResult {
    return {
        source_type: GLOBAL_SEARCH_RESULT_SOURCES.M3u,
        content_type: GLOBAL_SEARCH_CONTENT_TYPES.Live,
        playlist_id: playlist._id,
        playlist_name: playlist.title,
        channel_id: channel.id,
        stream_url: channel.url,
        group_title: channel.group.title,
        radio: channel.radio,
        poster_url: channel.tvg.logo || null,
        channel,
        id: `${playlist._id}::${channel.id || channel.url}`,
        category_id: 'm3u',
        title: channel.name || channel.tvg.name || channel.url,
        rating: null,
        added: null,
        xtream_id: -1,
        type: GLOBAL_SEARCH_CONTENT_TYPES.Live,
    };
}

function normalizeM3uChannel(value: unknown): Channel | null {
    if (!value || typeof value !== 'object') return null;
    const source = value as Partial<Channel>;
    const url = String(source.url ?? '').trim();
    const name = String(source.name ?? source.tvg?.name ?? '').trim();
    if (!url || !name) return null;

    return {
        id: String(source.id ?? url),
        url,
        name,
        group: { title: String(source.group?.title ?? '') },
        tvg: {
            id: String(source.tvg?.id ?? ''),
            name: String(source.tvg?.name ?? ''),
            url: String(source.tvg?.url ?? ''),
            logo: String(source.tvg?.logo ?? ''),
            rec: String(source.tvg?.rec ?? ''),
        },
        epgParams: source.epgParams,
        timeshift: source.timeshift,
        catchup: source.catchup,
        http: {
            referrer: String(source.http?.referrer ?? ''),
            'user-agent': String(source.http?.['user-agent'] ?? ''),
            origin: String(source.http?.origin ?? ''),
        },
        radio: String(source.radio ?? ''),
        drm: source.drm,
        raw: source.raw,
    };
}

function scoreText(value: string, term: string): number | null {
    const text = foldSearchText(value);
    const query = foldSearchText(term);
    if (!query || !text.includes(query)) return null;
    if (text === query) return 0;
    if (text.startsWith(query)) return 1;
    return 2;
}
