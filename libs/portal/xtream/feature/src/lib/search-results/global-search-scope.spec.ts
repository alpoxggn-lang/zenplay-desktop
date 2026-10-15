import {
    filtersForGlobalSearchScope,
    globalSearchScopeFromFilters,
    GLOBAL_SEARCH_SCOPE_STORAGE_KEY,
    readStoredGlobalSearchScope,
} from './global-search-scope';

function createStorage(values: Record<string, string> = {}) {
    return {
        getItem: (key: string) => values[key] ?? null,
    };
}

describe('global search scope', () => {
    it.each([
        ['all', { live: true, movie: true, series: true }],
        ['live', { live: true, movie: false, series: false }],
        ['movie', { live: false, movie: true, series: false }],
        ['series', { live: false, movie: false, series: true }],
    ] as const)('maps %s to exclusive database filters', (scope, expected) => {
        expect(filtersForGlobalSearchScope(scope)).toEqual(expected);
    });

    it('derives one selected scope and treats mixed filters as all content', () => {
        expect(
            globalSearchScopeFromFilters({
                live: false,
                movie: true,
                series: false,
            })
        ).toBe('movie');
        expect(
            globalSearchScopeFromFilters({
                live: true,
                movie: true,
                series: false,
            })
        ).toBe('all');
    });

    it('restores the explicit scope before the legacy checkbox filters', () => {
        expect(
            readStoredGlobalSearchScope(
                createStorage({
                    [GLOBAL_SEARCH_SCOPE_STORAGE_KEY]: 'series',
                    'global-search-type-filters': JSON.stringify({
                        live: true,
                        movie: false,
                        series: false,
                    }),
                })
            )
        ).toBe('series');
    });

    it('migrates one legacy type and safely defaults invalid data to all', () => {
        expect(
            readStoredGlobalSearchScope(
                createStorage({
                    'global-search-type-filters': JSON.stringify({
                        live: false,
                        movie: true,
                        series: false,
                    }),
                })
            )
        ).toBe('movie');
        expect(
            readStoredGlobalSearchScope(
                createStorage({
                    'global-search-type-filters': '{not-json',
                })
            )
        ).toBe('all');
    });
});
