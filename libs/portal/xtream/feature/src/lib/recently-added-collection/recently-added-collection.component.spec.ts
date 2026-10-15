import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { of } from 'rxjs';
import {
    DatabaseService,
    type GlobalRecentlyAddedItem,
    ParentalLockService,
    RuntimeCapabilitiesService,
} from '@iptvnator/services';
import { RecentlyAddedCollectionComponent } from './recently-added-collection.component';

function item(
    id: number,
    overrides: Partial<GlobalRecentlyAddedItem> = {}
): GlobalRecentlyAddedItem {
    return {
        id,
        category_id: 10,
        title: `Title ${id}`,
        rating: '7.5',
        added: String(1_800_000_000 - id),
        added_at: String(1_800_000_000 - id),
        poster_url: '',
        xtream_id: id,
        type: 'movie',
        playlist_id: 'playlist-a',
        playlist_name: 'Playlist A',
        ...overrides,
    };
}

describe('RecentlyAddedCollectionComponent', () => {
    const getGlobalRecentlyAddedPage = jest.fn();
    const navigate = jest.fn();
    const lockVersion = signal(0);
    const withholdsEverything = signal(false);

    function createComponent(
        kind: 'vod' | 'series' = 'vod'
    ): RecentlyAddedCollectionComponent {
        TestBed.configureTestingModule({
            providers: [
                {
                    provide: ActivatedRoute,
                    useValue: {
                        snapshot: { data: { recentlyAddedKind: kind } },
                        queryParamMap: of(convertToParamMap({})),
                    },
                },
                {
                    provide: DatabaseService,
                    useValue: { getGlobalRecentlyAddedPage },
                },
                {
                    provide: RuntimeCapabilitiesService,
                    useValue: { supportsPortalActivityStorage: true },
                },
                {
                    provide: ParentalLockService,
                    useValue: { version: lockVersion, withholdsEverything },
                },
                { provide: Router, useValue: { navigate } },
            ],
        });
        return TestBed.runInInjectionContext(
            () => new RecentlyAddedCollectionComponent()
        );
    }

    beforeEach(() => {
        TestBed.resetTestingModule();
        getGlobalRecentlyAddedPage.mockReset();
        navigate.mockReset();
        lockVersion.set(0);
        withholdsEverything.set(false);
    });

    it('loads later pages from every eligible Xtream playlist without a fixed total cap', async () => {
        const firstPage = Array.from({ length: 48 }, (_, index) =>
            item(index + 1)
        );
        getGlobalRecentlyAddedPage
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce([item(49)]);
        const component = createComponent();

        await component.loadNextPage();
        await component.loadNextPage();

        expect(getGlobalRecentlyAddedPage.mock.calls).toEqual([
            ['vod', 48, 'xtream', 0],
            ['vod', 48, 'xtream', 48],
        ]);
        expect(component.items()).toHaveLength(49);
        expect(component.hasMore()).toBe(false);
    });

    it('does not start the initial page twice while its IPC request is pending', async () => {
        let resolvePage!: (value: GlobalRecentlyAddedItem[]) => void;
        getGlobalRecentlyAddedPage.mockReturnValueOnce(
            new Promise<GlobalRecentlyAddedItem[]>((resolve) => {
                resolvePage = resolve;
            })
        );
        const component = createComponent();

        const firstLoad = component.loadNextPage();
        const duplicateLoad = component.loadNextPage();

        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledTimes(1);
        resolvePage([item(1)]);
        await Promise.all([firstLoad, duplicateLoad]);

        expect(component.items()).toHaveLength(1);
    });

    it('keeps a failed page retryable instead of showing it as an empty catalog', async () => {
        getGlobalRecentlyAddedPage
            .mockRejectedValueOnce(new Error('database unavailable'))
            .mockResolvedValueOnce([item(1)]);
        const component = createComponent();

        await component.loadNextPage();

        expect(component.appendError()).toBe(true);
        expect(component.hasMore()).toBe(true);
        expect(component.items()).toEqual([]);

        await component.loadNextPage();

        expect(component.appendError()).toBe(false);
        expect(component.items()).toEqual([item(1)]);
    });

    it('does not query or expose catalog rows while parental filtering is fail-closed', async () => {
        withholdsEverything.set(true);
        const component = createComponent();

        await component.loadNextPage();

        expect(getGlobalRecentlyAddedPage).not.toHaveBeenCalled();
        expect(component.items()).toEqual([]);
    });

    it('deduplicates the same catalog title across Xtream sources', async () => {
        getGlobalRecentlyAddedPage.mockResolvedValueOnce([
            item(1, {
                title: '(4K) Arrival (2026)',
                release_year: 2026,
                tmdb_id: 329865,
            }),
            item(91, {
                title: 'Arrival (2026)',
                release_year: 2026,
                playlist_id: 'playlist-b',
                playlist_name: 'Playlist B',
            }),
        ]);
        const component = createComponent();

        await component.loadNextPage();

        expect(component.items()).toHaveLength(1);
        expect(component.items()[0].playlist_id).toBe('playlist-a');
    });

    it('uses the series feed whose imported timestamp prefers last_modified', async () => {
        getGlobalRecentlyAddedPage.mockResolvedValueOnce([
            item(7, { type: 'series', title: 'Updated series' }),
        ]);
        const component = createComponent('series');

        await component.loadNextPage();

        expect(component.titleKey).toBe(
            'WORKSPACE.DASHBOARD.ZENPLAY_RECENT_SERIES'
        );
        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledWith(
            'series',
            48,
            'xtream',
            0
        );
    });

    it('opens an item in the playlist and category that supplied it', () => {
        const component = createComponent('series');

        component.openItem(
            item(27, {
                type: 'series',
                category_id: 33,
                playlist_id: 'playlist-b',
            })
        );

        expect(navigate).toHaveBeenCalledWith(
            ['/workspace', 'xtreams', 'playlist-b', 'series', '33', '27'],
            { state: undefined }
        );
    });
});
