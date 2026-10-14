import type { DashboardRecentlyAddedItem } from '@iptvnator/workspace/dashboard/data-access';

export const ZENPLAY_RECENT_RAIL_LIMIT = 24;
export const ZENPLAY_CATALOG_POOL_LIMIT = 300;

export type ZenPlayCatalogItem = DashboardRecentlyAddedItem & {
    rating?: number | string | null;
    rating_5based?: number | string | null;
    rating_imdb?: number | string | null;
    releaseDate?: string | null;
    release_year?: number | string | null;
};

const EDITION_TOKENS =
    /\b(?:4k|uhd|fhd|full\s*hd|1080p?|720p?|480p?|latino|castellano|espa(?:ñ|n)ol|dual|multi|sub(?:titulado)?|hdr|dv|dolby\s*vision|hevc|x26[45])\b/giu;
const YEAR_PATTERN = /(?:^|\D)((?:18|19|20|21)\d{2})(?=\D|$)/g;

export function selectZenPlayRecentItems(
    items: readonly ZenPlayCatalogItem[],
    type: 'movie' | 'series',
    limit = ZENPLAY_RECENT_RAIL_LIMIT
): ZenPlayCatalogItem[] {
    return dedupeCatalogTitles(
        [...items]
            .filter((item) => item.type === type)
            .sort(compareCatalogRecency)
    ).slice(0, limit);
}

/** Mirrors Android's Tendencias: this year's newest titles, movies and shows interleaved. */
export function selectZenPlayTrendingItems(
    items: readonly ZenPlayCatalogItem[],
    year = new Date().getFullYear()
): ZenPlayCatalogItem[] {
    const currentYear = items.filter(
        (item) =>
            (item.type === 'movie' || item.type === 'series') &&
            zenPlayCatalogYear(item) === year
    );
    // Some providers do not publish a release year for every title. Keep the
    // section useful in that case by falling back to the newest real catalog
    // entries instead of making Tendencias disappear.
    const eligible = currentYear.length > 0 ? currentYear : items;
    const movies = selectZenPlayRecentItems(eligible, 'movie', 6);
    const series = selectZenPlayRecentItems(eligible, 'series', 4);
    const interleaved: ZenPlayCatalogItem[] = [];

    for (
        let index = 0;
        index < Math.max(movies.length, series.length);
        index++
    ) {
        if (movies[index]) interleaved.push(movies[index]);
        if (series[index]) interleaved.push(series[index]);
    }
    return interleaved;
}

export function zenPlayCatalogRating(item: ZenPlayCatalogItem): number | null {
    for (const value of [item.rating, item.rating_imdb]) {
        const rating = Number(value);
        if (Number.isFinite(rating) && rating > 0 && rating <= 10) {
            return Math.round(rating * 10) / 10;
        }
    }
    const fiveBased = Number(item.rating_5based);
    return Number.isFinite(fiveBased) && fiveBased > 0 && fiveBased <= 5
        ? Math.round(fiveBased * 20) / 10
        : null;
}

export function zenPlayCatalogYear(item: ZenPlayCatalogItem): number | null {
    const explicit = Number(item.release_year);
    if (explicit >= 1800 && explicit <= 2199) return explicit;

    const releaseDateYear = Number(item.releaseDate?.match(/\d{4}/)?.[0]);
    if (releaseDateYear >= 1800 && releaseDateYear <= 2199) {
        return releaseDateYear;
    }

    YEAR_PATTERN.lastIndex = 0;
    let latestTitleYear: string | undefined;
    let match: RegExpExecArray | null;
    while ((match = YEAR_PATTERN.exec(item.title)) !== null) {
        latestTitleYear = match[1];
    }
    const titleYear = Number(latestTitleYear);
    return titleYear >= 1800 && titleYear <= 2199 ? titleYear : null;
}

function compareCatalogRecency(
    left: ZenPlayCatalogItem,
    right: ZenPlayCatalogItem
): number {
    const timeDelta =
        catalogTimestamp(right.added_at) - catalogTimestamp(left.added_at);
    if (timeDelta !== 0) return timeDelta;

    const ratingDelta =
        (zenPlayCatalogRating(right) ?? 0) - (zenPlayCatalogRating(left) ?? 0);
    if (ratingDelta !== 0) return ratingDelta;

    const titleDelta = left.title.localeCompare(right.title);
    return titleDelta !== 0
        ? titleDelta
        : String(left.xtream_id).localeCompare(String(right.xtream_id));
}

function catalogTimestamp(value: string): number {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeCatalogTitles(
    items: readonly ZenPlayCatalogItem[]
): ZenPlayCatalogItem[] {
    const identities = new Set<string>();
    return items.filter((item) => {
        const canonical = canonicalTitle(item.title);
        const year = zenPlayCatalogYear(item);
        const titleKey = canonical || `xtream-${item.xtream_id}`;
        const identity = `${titleKey}:${year ?? 'unknown'}`;
        if (identities.has(identity)) return false;
        identities.add(identity);
        return true;
    });
}

function canonicalTitle(title: string): string {
    return title
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(EDITION_TOKENS, ' ')
        .replace(YEAR_PATTERN, ' ')
        .replace(/[^a-z0-9]+/gi, ' ')
        .trim()
        .toLowerCase();
}
