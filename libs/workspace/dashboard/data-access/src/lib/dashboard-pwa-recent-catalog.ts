import type {
    IXtreamDataSource,
    XtreamCredentials,
} from '@iptvnator/portal/xtream/data-access';
import {
    normalizeStalkerDate,
    type PlaylistMeta,
    type PortalAddedItem,
} from '@iptvnator/shared/interfaces';
import { toTimestamp } from './dashboard-mappers';

export interface DashboardRecentlyAddedItem extends PortalAddedItem {
    rating?: number | null;
    release_year?: number;
}

export const DEFAULT_XTREAM_RECENTLY_ADDED_LIMIT = 96;
const CURRENT_YEAR_MOVIE_CANDIDATE_LIMIT = 24;
const CURRENT_YEAR_SERIES_CANDIDATE_LIMIT = 16;

type CatalogType = 'movie' | 'series';

type RecentlyAddedMetadata = {
    added?: unknown;
    added_at?: unknown;
    backdrop_path?: unknown;
    backdrop_url?: unknown;
    category_id?: unknown;
    cover?: unknown;
    id?: unknown;
    last_modified?: unknown;
    name?: unknown;
    poster_url?: unknown;
    rating?: unknown;
    rating_5based?: unknown;
    rating_imdb?: unknown;
    release_date?: unknown;
    release_year?: unknown;
    releaseDate?: unknown;
    series_id?: unknown;
    stream_icon?: unknown;
    stream_id?: unknown;
    title?: unknown;
    xtream_id?: unknown;
    year?: unknown;
};

type CatalogDataSource = Pick<IXtreamDataSource, 'getContent'>;

type CatalogLoadResult =
    | {
          status: 'fulfilled';
          items: readonly unknown[];
          playlist: PlaylistMeta;
          type: CatalogType;
      }
    | { status: 'rejected' };

/** Loads only VOD/series catalogs; live rows never enter the dashboard pool. */
export async function loadPwaXtreamRecentlyAddedItems(
    dataSource: CatalogDataSource,
    playlists: readonly PlaylistMeta[],
    limit: number
): Promise<DashboardRecentlyAddedItem[]> {
    const sources = playlists
        .map((playlist) => ({
            credentials: playlistCredentials(playlist),
            playlist,
        }))
        .filter(
            (
                source
            ): source is {
                credentials: XtreamCredentials;
                playlist: PlaylistMeta;
            } => source.credentials !== null
        );
    const types: readonly CatalogType[] = ['movie', 'series'];
    const requests: Promise<CatalogLoadResult>[] = [];
    for (const { credentials, playlist } of sources) {
        for (const type of types) {
            requests.push(
                dataSource.getContent(playlist._id, credentials, type).then(
                    (items): CatalogLoadResult => ({
                        status: 'fulfilled',
                        items,
                        playlist,
                        type,
                    }),
                    (): CatalogLoadResult => ({ status: 'rejected' })
                )
            );
        }
    }
    const settled = await Promise.all(requests);
    const fulfilled = settled.filter(
        (
            result
        ): result is Extract<CatalogLoadResult, { status: 'fulfilled' }> =>
            result.status === 'fulfilled'
    );

    if (requests.length > 0 && fulfilled.length === 0) {
        throw new Error('Xtream recently-added catalogs unavailable');
    }

    const mapped: DashboardRecentlyAddedItem[] = [];
    for (const result of fulfilled) {
        for (const item of result.items) {
            const mappedItem = mapPwaCatalogItem(
                item as RecentlyAddedMetadata,
                result.playlist,
                result.type
            );
            if (mappedItem) mapped.push(mappedItem);
        }
    }
    return selectCatalogPool(mapped, limit);
}

export function withRecentlyAddedMetadata(
    item: PortalAddedItem,
    metadata: RecentlyAddedMetadata
): DashboardRecentlyAddedItem {
    const releaseYear = normalizeYear(metadata, item.title);
    return {
        ...item,
        rating: normalizeRating(metadata),
        ...(releaseYear ? { release_year: releaseYear } : {}),
    };
}

function mapPwaCatalogItem(
    item: RecentlyAddedMetadata,
    playlist: PlaylistMeta,
    type: CatalogType
): DashboardRecentlyAddedItem | null {
    const providerId = Number(
        item.xtream_id ??
            (type === 'series' ? item.series_id : item.stream_id) ??
            item.id
    );
    const title = nonEmptyString(item.title ?? item.name);
    if (!Number.isInteger(providerId) || providerId <= 0 || !title) return null;

    const releaseYear = normalizeYear(item, title);
    const posterUrl = nonEmptyString(
        item.poster_url ?? item.stream_icon ?? item.cover
    );
    const backdropUrl = readBackdrop(item);
    return {
        id: providerId,
        title,
        type,
        playlist_id: playlist._id,
        playlist_name: playlist.title || 'Xtream',
        added_at: normalizeStalkerDate(
            item.added_at ?? item.added ?? item.last_modified
        ),
        category_id: normalizeCategoryId(item.category_id),
        xtream_id: providerId,
        poster_url: posterUrl || undefined,
        backdrop_url: backdropUrl || undefined,
        rating: normalizeRating(item),
        ...(releaseYear ? { release_year: releaseYear } : {}),
        source: 'xtream',
    };
}

function selectCatalogPool(
    items: readonly DashboardRecentlyAddedItem[],
    limit: number
): DashboardRecentlyAddedItem[] {
    const normalizedLimit = Number.isFinite(limit)
        ? Math.max(0, Math.trunc(limit))
        : DEFAULT_XTREAM_RECENTLY_ADDED_LIMIT;
    if (normalizedLimit === 0) return [];

    const sorted = [...items].sort(
        (a, b) => toTimestamp(b.added_at) - toTimestamp(a.added_at)
    );
    const unique = new Set<string>();
    const byType: Record<CatalogType, DashboardRecentlyAddedItem[]> = {
        movie: [],
        series: [],
    };

    for (const item of sorted) {
        if (item.type !== 'movie' && item.type !== 'series') continue;
        const key = `${item.playlist_id}:${item.type}:${item.xtream_id}`;
        if (unique.has(key)) continue;
        unique.add(key);
        byType[item.type].push(item);
    }

    const recent = [
        ...byType.movie.slice(0, Math.ceil(normalizedLimit / 2)),
        ...byType.series.slice(0, Math.floor(normalizedLimit / 2)),
    ];
    const currentYear = new Date().getFullYear();
    const trendingCandidates = [
        ...byType.movie
            .filter((item) => item.release_year === currentYear)
            .slice(0, CURRENT_YEAR_MOVIE_CANDIDATE_LIMIT),
        ...byType.series
            .filter((item) => item.release_year === currentYear)
            .slice(0, CURRENT_YEAR_SERIES_CANDIDATE_LIMIT),
    ];
    const pool = new Map(
        [...recent, ...trendingCandidates].map((item) => [
            `${item.playlist_id}:${item.type}:${item.xtream_id}`,
            item,
        ])
    );
    return [...pool.values()].sort(
        (a, b) => toTimestamp(b.added_at) - toTimestamp(a.added_at)
    );
}

function playlistCredentials(playlist: PlaylistMeta): XtreamCredentials | null {
    const serverUrl = playlist.serverUrl?.trim();
    const username = playlist.username?.trim();
    const password = playlist.password?.trim();
    return serverUrl && username && password
        ? {
              serverUrl,
              username,
              password,
              serverTimezone: playlist.serverTimezone,
          }
        : null;
}

function normalizeRating(item: RecentlyAddedMetadata): number | null {
    let zeroRating = false;
    for (const raw of [item.rating, item.rating_imdb]) {
        const rating = finiteNumber(raw);
        if (rating !== null && rating > 0 && rating <= 10) {
            return Math.round(rating * 10) / 10;
        }
        zeroRating ||= rating === 0;
    }
    const fiveBased = finiteNumber(item.rating_5based);
    if (fiveBased !== null && fiveBased > 0 && fiveBased <= 5) {
        return Math.round(fiveBased * 20) / 10;
    }
    return zeroRating || fiveBased === 0 ? 0 : null;
}

function normalizeYear(
    item: RecentlyAddedMetadata,
    title: string
): number | undefined {
    for (const raw of [item.release_year, item.year]) {
        const year = releaseYear(raw);
        if (year) return year;
    }
    for (const raw of [item.releaseDate, item.release_date]) {
        const year = releaseYear(
            nonEmptyString(raw)?.match(/(?:18|19|20|21)\d{2}/)?.[0]
        );
        if (year) return year;
    }
    const yearPattern = /(?:^|\D)((?:18|19|20|21)\d{2})(?=\D|$)/g;
    let latestTitleYear: string | undefined;
    let match: RegExpExecArray | null;
    while ((match = yearPattern.exec(title)) !== null) {
        latestTitleYear = match[1];
    }
    return releaseYear(latestTitleYear);
}

function releaseYear(value: unknown): number | undefined {
    const year = finiteNumber(value);
    return year !== null &&
        Number.isInteger(year) &&
        year >= 1800 &&
        year <= 2199
        ? year
        : undefined;
}

function finiteNumber(value: unknown): number | null {
    if (typeof value === 'string' && !value.trim()) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readBackdrop(item: RecentlyAddedMetadata): string | null {
    const direct = nonEmptyString(item.backdrop_url);
    if (direct) return direct;
    return Array.isArray(item.backdrop_path)
        ? nonEmptyString(item.backdrop_path[0])
        : nonEmptyString(item.backdrop_path);
}

function normalizeCategoryId(value: unknown): string | number {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : (nonEmptyString(value) ?? '0');
}
