import {
    TmdbRecommendation,
    normalizeTitleKeys,
    titleYearsCompatible,
} from '@iptvnator/shared/interfaces';

/**
 * Matches TMDB recommendations against the provider catalog so the
 * "Similar" rail only shows titles the user can actually play.
 *
 * Matching is two-tier: TMDB titles are canonical (a trailing year is part
 * of the title — "Blade Runner 2049"), provider titles are dirty (a
 * trailing year is usually a release tag — "The Matrix 1999"). The exact
 * normalized forms are compared first; the provider's year-stripped form
 * only counts when the stripped year does not contradict the TMDB year.
 */

export interface SimilarCatalogItem {
    id: number;
    categoryId: string;
    title: string;
    posterUrl: string | null;
    /** TMDB release year of the recommendation that matched. */
    year: number | null;
}

/** Catalog rows vary by source (API vs DB) — fields are read structurally */
type CatalogStream = object;

function field(stream: CatalogStream, key: string): unknown {
    return (stream as Record<string, unknown>)[key];
}

function streamId(stream: CatalogStream): number | null {
    const candidate =
        field(stream, 'xtream_id') ??
        field(stream, 'stream_id') ??
        field(stream, 'series_id') ??
        field(stream, 'id');
    const parsed = Number(candidate);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function streamTitle(stream: CatalogStream): string {
    const title = field(stream, 'name') ?? field(stream, 'title');
    return typeof title === 'string' ? title : '';
}

function streamPoster(stream: CatalogStream): string | null {
    const poster =
        field(stream, 'stream_icon') ??
        field(stream, 'cover') ??
        field(stream, 'poster_url');
    return typeof poster === 'string' && poster !== '' ? poster : null;
}

function streamCategoryId(stream: CatalogStream): string | null {
    const categoryId =
        field(stream, 'category_id') ?? field(stream, 'categoryId');
    return categoryId === undefined || categoryId === null
        ? null
        : String(categoryId);
}

function streamGenres(stream: CatalogStream): Set<string> {
    const value = field(stream, 'genre') ?? field(stream, 'genres');
    const genres = Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? value.split(/[,/|]/)
          : [];

    return new Set(
        genres
            .map((genre) => normalizeTitleKeys(String(genre)).exact)
            .filter((genre) => genre.length > 0)
    );
}

export interface CatalogMatch {
    id: number;
    categoryId: string;
}

interface IndexedCatalogEntry extends CatalogMatch {
    /** Year tag stripped from the provider title (base-tier entries only) */
    trailingYear: number | null;
}

/**
 * Two-tier catalog index for per-title availability checks (actor page
 * filmography). First occurrence of a title wins per tier.
 */
export interface CatalogTitleIndex {
    exact: Map<string, IndexedCatalogEntry>;
    base: Map<string, IndexedCatalogEntry>;
}

export function buildCatalogTitleIndex(
    streams: readonly CatalogStream[]
): CatalogTitleIndex {
    const exact = new Map<string, IndexedCatalogEntry>();
    const base = new Map<string, IndexedCatalogEntry>();
    for (const stream of streams) {
        const keys = normalizeTitleKeys(streamTitle(stream));
        if (!keys.exact) {
            continue;
        }
        const id = streamId(stream);
        const categoryId =
            field(stream, 'category_id') ?? field(stream, 'categoryId');
        if (id === null || categoryId === undefined || categoryId === null) {
            continue;
        }
        const entry: IndexedCatalogEntry = {
            id,
            categoryId: String(categoryId),
            trailingYear: keys.trailingYear,
        };
        if (!exact.has(keys.exact)) {
            exact.set(keys.exact, { ...entry, trailingYear: null });
        }
        // The base tier only exists for titles that carried a year tag
        if (keys.base !== keys.exact && !base.has(keys.base)) {
            base.set(keys.base, entry);
        }
    }
    return { exact, base };
}

/**
 * Looks up a TMDB title (canonical — never year-stripped) in the catalog
 * index. Base-tier hits require the provider's stripped year tag to be
 * compatible with the TMDB year, so "Blade Runner" (1982) never claims the
 * catalog's "Blade Runner 2049".
 */
export function lookupCatalogTitle(
    index: CatalogTitleIndex,
    title: string,
    year?: number | null
): CatalogMatch | null {
    const wanted = normalizeTitleKeys(title).exact;
    if (!wanted) {
        return null;
    }
    const exactHit = index.exact.get(wanted);
    if (exactHit) {
        return exactHit;
    }
    const baseHit = index.base.get(wanted);
    return baseHit && titleYearsCompatible(year, baseHit.trailingYear)
        ? baseHit
        : null;
}

export function matchRecommendationsToCatalog(
    recommendations: readonly TmdbRecommendation[] | undefined,
    streams: readonly CatalogStream[],
    options: { excludeId?: number; limit?: number } = {}
): SimilarCatalogItem[] {
    if (!recommendations?.length || !streams.length) {
        return [];
    }

    // Wanted keys are the EXACT normalized TMDB titles
    const wanted = new Map<string, TmdbRecommendation>();
    for (const recommendation of recommendations) {
        const key = normalizeTitleKeys(recommendation.title).exact;
        if (key && !wanted.has(key)) {
            wanted.set(key, recommendation);
        }
    }

    // Single pass over the catalog; stop as soon as every wanted title has
    // a candidate — catalogs can hold tens of thousands of rows.
    const catalogHits = new Map<string, CatalogStream>();
    for (const stream of streams) {
        if (catalogHits.size >= wanted.size) {
            break;
        }
        const keys = normalizeTitleKeys(streamTitle(stream));
        if (!keys.exact) {
            continue;
        }
        if (wanted.has(keys.exact) && !catalogHits.has(keys.exact)) {
            catalogHits.set(keys.exact, stream);
            continue;
        }
        // Base tier: provider title carried a year tag — only match when
        // that year does not contradict the recommendation's year
        if (keys.base === keys.exact || catalogHits.has(keys.base)) {
            continue;
        }
        const recommendation = wanted.get(keys.base);
        if (
            recommendation &&
            titleYearsCompatible(recommendation.year, keys.trailingYear)
        ) {
            catalogHits.set(keys.base, stream);
        }
    }

    const limit = options.limit ?? 12;
    const seenIds = new Set<number>();
    const matched: SimilarCatalogItem[] = [];

    for (const [key, recommendation] of wanted) {
        if (matched.length >= limit) {
            break;
        }
        const stream = catalogHits.get(key);
        if (!stream) {
            continue;
        }
        const id = streamId(stream);
        const categoryId =
            field(stream, 'category_id') ?? field(stream, 'categoryId');
        if (
            id === null ||
            id === options.excludeId ||
            seenIds.has(id) ||
            categoryId === undefined ||
            categoryId === null
        ) {
            continue;
        }
        seenIds.add(id);
        matched.push({
            id,
            categoryId: String(categoryId),
            title: streamTitle(stream),
            posterUrl: recommendation.posterUrl ?? streamPoster(stream),
            year: recommendation.year ?? null,
        });
    }

    return matched;
}

/**
 * Provider-local fallback for the Similar rail when TMDB supplies no usable
 * recommendations (disabled, unavailable, rate-limited, or simply empty).
 *
 * Genre overlap wins; a shared provider category is the lower-confidence
 * fallback used by sparse VOD rows. Original catalog order breaks ties so the
 * result stays stable and never invents titles outside the user's library.
 */
export function matchRelatedCatalogItems(
    streams: readonly CatalogStream[],
    options: {
        excludeId?: number;
        categoryId?: string | number | null;
        genres?: string | readonly string[] | null;
        limit?: number;
    } = {}
): SimilarCatalogItem[] {
    const wantedGenres = streamGenres({ genre: options.genres ?? '' });
    const wantedCategory =
        options.categoryId === undefined || options.categoryId === null
            ? null
            : String(options.categoryId);
    const limit = options.limit ?? 12;
    const seenIds = new Set<number>();

    return streams
        .map((stream, catalogIndex) => {
            const id = streamId(stream);
            if (
                id === null ||
                id === options.excludeId
            ) {
                return null;
            }

            const categoryId = streamCategoryId(stream);
            if (categoryId === null) {
                return null;
            }
            const genreMatches = [...streamGenres(stream)].filter((genre) =>
                wantedGenres.has(genre)
            ).length;
            const categoryMatches =
                wantedCategory !== null && categoryId === wantedCategory;
            const score = genreMatches * 10 + (categoryMatches ? 1 : 0);
            if (score === 0) {
                return null;
            }

            const title = streamTitle(stream);
            if (!title) {
                return null;
            }
            if (seenIds.has(id)) {
                return null;
            }
            seenIds.add(id);
            return {
                item: {
                    id,
                    categoryId,
                    title,
                    posterUrl: streamPoster(stream),
                    year: normalizeTitleKeys(title).trailingYear,
                } satisfies SimilarCatalogItem,
                score,
                catalogIndex,
            };
        })
        .filter(
            (
                candidate
            ): candidate is {
                item: SimilarCatalogItem;
                score: number;
                catalogIndex: number;
            } => candidate !== null
        )
        .sort(
            (left, right) =>
                right.score - left.score ||
                left.catalogIndex - right.catalogIndex
        )
        .slice(0, limit)
        .map((candidate) => candidate.item);
}
