import type { ZenPlayCatalogItem } from './dashboard-zenplay-catalog';
import {
    selectZenPlayRecentItems,
    selectZenPlayTrendingItems,
    zenPlayCatalogRating,
    zenPlayCatalogYear,
} from './dashboard-zenplay-catalog';

const item = (
    id: number,
    type: 'movie' | 'series',
    title: string,
    addedAt: string,
    extra: Partial<ZenPlayCatalogItem> = {}
): ZenPlayCatalogItem => ({
    id,
    title,
    type,
    playlist_id: 'zenplay-primary',
    playlist_name: 'ZenPlay',
    added_at: addedAt,
    category_id: type === 'movie' ? 10 : 20,
    xtream_id: id,
    source: 'xtream',
    ...extra,
});

describe('ZenPlay dashboard catalog selectors', () => {
    it('separates and orders recent movies and series by provider timestamp', () => {
        const rows = [
            item(1, 'movie', 'Older', '1767225600'),
            item(2, 'series', 'Show', '2026-02-01T00:00:00.000Z'),
            item(3, 'movie', 'Newest', '1772323200'),
        ];

        expect(
            selectZenPlayRecentItems(rows, 'movie').map((row) => row.id)
        ).toEqual([3, 1]);
        expect(
            selectZenPlayRecentItems(rows, 'series').map((row) => row.id)
        ).toEqual([2]);
    });

    it('keeps only this year in Tendencias and alternates movies with series', () => {
        const rows = [
            item(1, 'movie', 'Film A (2026)', '2026-10-03'),
            item(2, 'movie', 'Film B (2026)', '2026-10-02'),
            item(3, 'series', 'Show A', '2026-10-01', {
                releaseDate: '2026-04-12',
            }),
            item(4, 'series', 'Old show (2025)', '2026-10-04'),
        ];

        expect(
            selectZenPlayTrendingItems(rows, 2026).map((row) => row.id)
        ).toEqual([1, 3, 2]);
    });

    it('falls back to newest catalog entries when release years are unavailable', () => {
        const rows = [
            item(1, 'movie', 'Film without year', '2026-10-03'),
            item(2, 'series', 'Show without year', '2026-10-02'),
        ];

        expect(
            selectZenPlayTrendingItems(rows, 2026).map((row) => row.id)
        ).toEqual([1, 2]);
    });

    it('collapses quality and language editions but preserves dated remakes', () => {
        const rows = [
            item(1, 'movie', 'Mi película (2026) 4K Latino', '2026-10-03'),
            item(2, 'movie', 'Mi Pelicula 2026 1080p Dual', '2026-10-02'),
            item(3, 'movie', 'Mi película (1999)', '2026-10-01'),
        ];

        expect(
            selectZenPlayRecentItems(rows, 'movie').map((row) => row.id)
        ).toEqual([1, 3]);
    });

    it('does not discard a dated remake after an undated edition', () => {
        const rows = [
            item(1, 'movie', 'Mi película 4K Latino', '2026-10-03'),
            item(2, 'movie', 'Mi película (1999)', '2026-10-02'),
        ];

        expect(
            selectZenPlayRecentItems(rows, 'movie').map((row) => row.id)
        ).toEqual([1, 2]);
    });

    it('normalizes provider rating and release-year fallbacks', () => {
        expect(
            zenPlayCatalogRating(item(1, 'movie', 'A', '1', { rating: '8.44' }))
        ).toBe(8.4);
        expect(
            zenPlayCatalogRating(
                item(2, 'series', 'B', '1', { rating_5based: 4.2 })
            )
        ).toBe(8.4);
        expect(zenPlayCatalogYear(item(3, 'movie', 'Title (2026)', '1'))).toBe(
            2026
        );
    });
});
