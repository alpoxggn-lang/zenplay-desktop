import { SearchFilters } from '@iptvnator/portal/xtream/data-access';

export type GlobalSearchScope = 'all' | keyof SearchFilters;

export const GLOBAL_SEARCH_SCOPE_STORAGE_KEY = 'global-search-content-scope';
const LEGACY_TYPE_FILTERS_STORAGE_KEY = 'global-search-type-filters';

const ALL_FILTERS: SearchFilters = {
    live: true,
    movie: true,
    series: true,
};

export function isGlobalSearchScope(
    value: unknown
): value is GlobalSearchScope {
    return (
        value === 'all' ||
        value === 'live' ||
        value === 'movie' ||
        value === 'series'
    );
}

export function filtersForGlobalSearchScope(
    scope: GlobalSearchScope
): SearchFilters {
    if (scope === 'all') {
        return { ...ALL_FILTERS };
    }

    return {
        live: scope === 'live',
        movie: scope === 'movie',
        series: scope === 'series',
    };
}

export function globalSearchScopeFromFilters(
    filters: SearchFilters
): GlobalSearchScope {
    const enabledScopes = (
        Object.keys(filters) as (keyof SearchFilters)[]
    ).filter((scope) => filters[scope]);

    return enabledScopes.length === 1 ? enabledScopes[0] : 'all';
}

export function readStoredGlobalSearchScope(
    storage: Pick<Storage, 'getItem'>
): GlobalSearchScope {
    const savedScope = storage.getItem(GLOBAL_SEARCH_SCOPE_STORAGE_KEY);
    if (isGlobalSearchScope(savedScope)) {
        return savedScope;
    }

    const legacyFilters = storage.getItem(LEGACY_TYPE_FILTERS_STORAGE_KEY);
    if (!legacyFilters) {
        return 'all';
    }

    try {
        const parsed = JSON.parse(legacyFilters) as Partial<SearchFilters>;
        return globalSearchScopeFromFilters({
            live: parsed.live !== false,
            movie: parsed.movie !== false,
            series: parsed.series !== false,
        });
    } catch {
        return 'all';
    }
}
