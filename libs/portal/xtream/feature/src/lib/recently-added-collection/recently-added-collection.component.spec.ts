import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { XtreamStore } from '@iptvnator/portal/xtream/data-access';
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
    const queryParamMap = new BehaviorSubject(convertToParamMap({}));
    const activeImportSessionId = signal<string | null>(null);
    const contentLoadStateByType = signal<
        Record<
            'live' | 'vod' | 'series',
            'idle' | 'loading' | 'ready' | 'error'
        >
    >({
        live: 'ready',
        vod: 'ready',
        series: 'ready',
    });
    const isContentInitialized = signal(true);
    const isPendingRestoreBlocked = signal(false);
    const contentInitBlockReason = signal<string | null>(null);
    const vodCategories = signal([{ category_id: '10' }]);
    const serialCategories = signal([{ category_id: '20' }]);

    function createComponent(
        kind: 'vod' | 'series' = 'vod'
    ): RecentlyAddedCollectionComponent {
        TestBed.configureTestingModule({
            providers: [
                {
                    provide: ActivatedRoute,
                    useValue: {
                        snapshot: { data: { recentlyAddedKind: kind } },
                        queryParamMap,
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
                {
                    provide: XtreamStore,
                    useValue: {
                        activeImportSessionId,
                        contentInitBlockReason,
                        contentLoadStateByType,
                        isContentInitialized,
                        isPendingRestoreBlocked,
                        serialCategories,
                        vodCategories,
                    },
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
        queryParamMap.next(convertToParamMap({}));
        activeImportSessionId.set(null);
        contentLoadStateByType.set({
            live: 'ready',
            vod: 'ready',
            series: 'ready',
        });
        isContentInitialized.set(true);
        isPendingRestoreBlocked.set(false);
        contentInitBlockReason.set(null);
        vodCategories.set([{ category_id: '10' }]);
        serialCategories.set([{ category_id: '20' }]);
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

    it('waits for the explicit retry action after an appended page fails', async () => {
        const firstPage = Array.from({ length: 48 }, (_, index) =>
            item(index + 1)
        );
        getGlobalRecentlyAddedPage
            .mockResolvedValueOnce(firstPage)
            .mockRejectedValueOnce(new Error('database unavailable'))
            .mockResolvedValueOnce([item(49)]);
        const component = createComponent();

        await component.loadNextPage();
        await component.loadNextPage();
        component.onLoadMore();
        await Promise.resolve();

        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledTimes(2);
        expect(component.appendError()).toBe(true);
        expect(component.items()).toEqual(firstPage);

        component.retryLoadMore();
        await Promise.resolve();
        await Promise.resolve();

        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledTimes(3);
        expect(component.appendError()).toBe(false);
        expect(component.items()).toEqual([...firstPage, item(49)]);
    });

    it('does not query or expose catalog rows while parental filtering is fail-closed', async () => {
        withholdsEverything.set(true);
        const component = createComponent();

        await component.loadNextPage();

        expect(getGlobalRecentlyAddedPage).not.toHaveBeenCalled();
        expect(component.items()).toEqual([]);
    });

    it('discards a page that resolves after parental filtering becomes fail-closed', async () => {
        let resolvePage!: (value: GlobalRecentlyAddedItem[]) => void;
        getGlobalRecentlyAddedPage.mockReturnValueOnce(
            new Promise<GlobalRecentlyAddedItem[]>((resolve) => {
                resolvePage = resolve;
            })
        );
        const component = createComponent();

        const load = component.loadNextPage();
        withholdsEverything.set(true);
        resolvePage([item(1)]);
        await load;

        expect(component.items()).toEqual([]);
    });

    it('keeps source, language, and quality variants with the same catalog title', async () => {
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

        expect(component.items()).toHaveLength(2);
        expect(component.items().map(({ playlist_id }) => playlist_id)).toEqual(
            ['playlist-a', 'playlist-b']
        );
    });

    it('sends q to the database so search covers unloaded recent pages', async () => {
        queryParamMap.next(convertToParamMap({ q: 'matrix' }));
        getGlobalRecentlyAddedPage.mockResolvedValueOnce([
            item(120, { title: 'The Matrix' }),
        ]);
        const component = createComponent();

        await component.loadNextPage();

        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledWith(
            'vod',
            48,
            'xtream',
            0,
            'matrix'
        );
        expect(component.items()).toEqual([item(120, { title: 'The Matrix' })]);
    });

    it('discards an older in-flight page and restarts a changed query at offset zero', async () => {
        let resolveInitialPage!: (value: GlobalRecentlyAddedItem[]) => void;
        getGlobalRecentlyAddedPage
            .mockReturnValueOnce(
                new Promise<GlobalRecentlyAddedItem[]>((resolve) => {
                    resolveInitialPage = resolve;
                })
            )
            .mockResolvedValueOnce([item(120, { title: 'The Matrix' })]);
        const component = createComponent();
        component.ngOnInit();
        TestBed.flushEffects();

        queryParamMap.next(convertToParamMap({ q: 'matrix' }));
        TestBed.flushEffects();
        resolveInitialPage([item(1, { title: 'Old page' })]);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(getGlobalRecentlyAddedPage.mock.calls).toEqual([
            ['vod', 48, 'xtream', 0],
            ['vod', 48, 'xtream', 0, 'matrix'],
        ]);
        expect(component.items()).toEqual([item(120, { title: 'The Matrix' })]);
    });

    it('reloads after the active Xtream import has fully completed', async () => {
        activeImportSessionId.set('import-1');
        isContentInitialized.set(false);
        contentLoadStateByType.set({
            live: 'ready',
            vod: 'loading',
            series: 'loading',
        });
        getGlobalRecentlyAddedPage
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([item(2, { title: 'Imported movie' })]);
        const component = createComponent();
        component.ngOnInit();
        TestBed.flushEffects();
        await Promise.resolve();

        contentLoadStateByType.set({
            live: 'ready',
            vod: 'ready',
            series: 'ready',
        });
        isContentInitialized.set(true);
        TestBed.flushEffects();
        await Promise.resolve();

        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledTimes(1);

        activeImportSessionId.set(null);
        TestBed.flushEffects();
        await Promise.resolve();
        await Promise.resolve();

        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledTimes(2);
        expect(component.items()).toEqual([
            item(2, { title: 'Imported movie' }),
        ]);
    });

    it('reloads after cached deep-link hydration becomes ready without an import session', async () => {
        isContentInitialized.set(false);
        contentLoadStateByType.set({
            live: 'ready',
            vod: 'loading',
            series: 'loading',
        });
        getGlobalRecentlyAddedPage
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([item(3, { title: 'Hydrated movie' })]);
        const component = createComponent();
        component.ngOnInit();
        TestBed.flushEffects();
        await Promise.resolve();

        contentLoadStateByType.set({
            live: 'ready',
            vod: 'ready',
            series: 'loading',
        });
        isContentInitialized.set(true);
        TestBed.flushEffects();
        await Promise.resolve();
        await Promise.resolve();

        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledTimes(2);
        expect(component.items()).toEqual([
            item(3, { title: 'Hydrated movie' }),
        ]);
    });

    it('reloads when the visible categories change', async () => {
        getGlobalRecentlyAddedPage
            .mockResolvedValueOnce([item(1, { title: 'Before' })])
            .mockResolvedValueOnce([item(2, { title: 'After' })]);
        const component = createComponent();
        component.ngOnInit();
        TestBed.flushEffects();
        await Promise.resolve();

        vodCategories.set([{ category_id: '11' }]);
        TestBed.flushEffects();
        await Promise.resolve();
        await Promise.resolve();

        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledTimes(2);
        expect(component.items()).toEqual([item(2, { title: 'After' })]);
    });

    it('defers an import-terminal reload until pending restore is unblocked', async () => {
        activeImportSessionId.set('import-1');
        isContentInitialized.set(false);
        contentLoadStateByType.set({
            live: 'ready',
            vod: 'loading',
            series: 'loading',
        });
        getGlobalRecentlyAddedPage
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([item(4, { title: 'Restored movie' })]);
        const component = createComponent();
        component.ngOnInit();
        TestBed.flushEffects();
        await Promise.resolve();

        contentLoadStateByType.set({
            live: 'ready',
            vod: 'ready',
            series: 'ready',
        });
        isContentInitialized.set(true);
        isPendingRestoreBlocked.set(true);
        activeImportSessionId.set(null);
        TestBed.flushEffects();
        await Promise.resolve();

        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledTimes(1);

        isPendingRestoreBlocked.set(false);
        TestBed.flushEffects();
        await Promise.resolve();
        await Promise.resolve();

        expect(getGlobalRecentlyAddedPage).toHaveBeenCalledTimes(2);
        expect(component.items()).toEqual([
            item(4, { title: 'Restored movie' }),
        ]);
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
