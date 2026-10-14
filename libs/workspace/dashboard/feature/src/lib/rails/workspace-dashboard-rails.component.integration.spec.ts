import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslateModule, TranslatePipe } from '@ngx-translate/core';
import {
    PlaylistDeleteActionService,
    RuntimeCapabilitiesService,
    SettingsStore,
} from '@iptvnator/services';
import {
    DEFAULT_DASHBOARD_RAILS_SETTINGS,
    type DashboardRailsSettings,
    type PlaylistMeta,
} from '@iptvnator/shared/interfaces';
import { DialogService } from '@iptvnator/ui/components';
import {
    DashboardDataService,
    DashboardRecommendationsService,
    DashboardSourceExpiryService,
    DashboardTrendingService,
    type DashboardRecentlyAddedItem,
    type GlobalRecentItem,
} from '@iptvnator/workspace/dashboard/data-access';
import { WORKSPACE_SHELL_ACTIONS } from '@iptvnator/workspace/shell/util';
import { PlaylistRefreshActionService } from '@iptvnator/playlist/shared/ui';
import { DashboardLiveEpgPresenter } from './dashboard-live-epg.presenter';
import { WorkspaceDashboardRailsComponent } from './workspace-dashboard-rails.component';

@Component({
    selector: 'lib-dashboard-rail',
    standalone: true,
    template: `
        <section [attr.data-test-id]="testId">
            <h2>{{ label }}</h2>
        </section>
    `,
})
class DashboardRailStubComponent {
    @Input() label = '';
    @Input() items: readonly unknown[] = [];
    @Input() totalCount = 0;
    @Input() seeAllLink: readonly unknown[] | null = null;
    @Input() seeAllState: Record<string, unknown> | null = null;
    @Input() testId = '';
    @Input() reserveMetaLine = false;
    @Input() layout = 'cover';
    @Input() aspectRatio = '';
    @Output() readonly actionSelected = new EventEmitter<unknown>();
    @Output() readonly visibleCardsChanged = new EventEmitter<unknown[]>();
}

@Component({
    selector: 'lib-dashboard-rail-skeleton',
    standalone: true,
    template: '',
})
class DashboardRailSkeletonStubComponent {
    @Input() testId = '';
    @Input() layout = 'cover';
    @Input() aspectRatio = '';
}

@Component({
    selector: 'lib-dashboard-hero',
    standalone: true,
    template: `
        <section
            [attr.data-test-id]="
                mode === 'zenplay-trending'
                    ? 'dashboard-zenplay-trending-hero'
                    : 'dashboard-personalized-hero'
            "
        ></section>
    `,
})
class DashboardHeroStubComponent {
    @Input() mode: 'personalized' | 'zenplay-trending' = 'personalized';
}

@Component({
    // Production selector; this stub must match the parent template exactly.
    // eslint-disable-next-line @angular-eslint/component-selector
    selector: 'app-empty-state',
    standalone: true,
    template: '',
})
class EmptyStateStubComponent {
    @Input() type = '';
    @Input() showElectronOnlyValueProps = false;
    @Output() readonly addPlaylistClicked = new EventEmitter<unknown>();
}

describe('WorkspaceDashboardRailsComponent ZenPlay home integration', () => {
    const currentYear = new Date().getFullYear();
    const playlist = {
        _id: 'zenplay-primary',
        title: 'ZenPlay',
        importDate: '2026-10-13T00:00:00.000Z',
        autoRefresh: false,
        serverUrl: 'https://provider.example.test',
        username: 'demo',
        password: 'secret',
    } as PlaylistMeta;
    const recentlyAdded: DashboardRecentlyAddedItem[] = [
        {
            id: 101,
            title: `Película reciente (${currentYear})`,
            type: 'movie',
            playlist_id: playlist._id,
            playlist_name: playlist.title,
            category_id: 10,
            xtream_id: 101,
            added_at: '2026-10-13T09:00:00.000Z',
            release_year: currentYear,
            rating: 8.4,
        },
        {
            id: 202,
            title: `Serie reciente (${currentYear})`,
            type: 'series',
            playlist_id: playlist._id,
            playlist_name: playlist.title,
            category_id: 20,
            xtream_id: 202,
            added_at: '2026-10-13T08:00:00.000Z',
            release_year: currentYear,
            rating: 8.1,
        },
    ];
    const continueWatching: GlobalRecentItem = {
        id: 303,
        title: 'Continuar película',
        type: 'movie',
        playlist_id: playlist._id,
        playlist_name: playlist.title,
        category_id: 30,
        xtream_id: 303,
        viewed_at: '2026-10-13T10:00:00.000Z',
    };

    const rails: DashboardRailsSettings = {
        ...DEFAULT_DASHBOARD_RAILS_SETTINGS,
        hero: false,
        liveFavorites: false,
        recentlyWatchedLive: false,
        favoriteMoviesAndSeries: false,
        recentSources: false,
        tmdbTrending: false,
        tmdbRecommendations: false,
    };

    async function render(isElectron: boolean): Promise<{
        fixture: ComponentFixture<WorkspaceDashboardRailsComponent>;
        railStubs: () => DashboardRailStubComponent[];
    }> {
        const data = {
            playlists: signal([playlist]),
            playlistsLoaded: signal(true),
            dashboardReady: signal(true),
            xtreamPlaylistCount: signal(1),
            globalFavoritesLoading: signal(false),
            globalFavoritesLoaded: signal(false),
            globalRecentLoading: signal(false),
            continueWatchingSettled: signal(true),
            xtreamRecentlyAddedLoading: signal(false),
            xtreamRecentlyAddedItems: signal(recentlyAdded),
            continueWatchingItems: signal([continueWatching]),
            globalRecentVodItems: signal([continueWatching]),
            globalRecentLiveItems: signal([]),
            globalFavoriteItems: signal([]),
            globalFavoriteLiveItems: signal([]),
            recentPlaylists: signal([]),
            reloadGlobalRecentItems: jest.fn().mockResolvedValue(undefined),
            reloadGlobalFavorites: jest.fn().mockResolvedValue(undefined),
            reloadXtreamRecentlyAddedItems: jest
                .fn()
                .mockResolvedValue(undefined),
            reloadPlaybackPositions: jest.fn().mockResolvedValue(undefined),
            getPlaybackPositionForItem: jest.fn().mockReturnValue(null),
            getRecentItemLink: jest.fn().mockReturnValue(['/workspace/detail']),
            getRecentItemDetailNavigationState: jest
                .fn()
                .mockReturnValue(undefined),
            getRecentItemResumeNavigation: jest.fn().mockReturnValue(null),
            getRecentlyAddedLink: jest
                .fn()
                .mockImplementation((item: DashboardRecentlyAddedItem) => [
                    '/workspace/catalog',
                    item.type,
                    item.xtream_id,
                ]),
            getRecentlyAddedNavigationState: jest
                .fn()
                .mockReturnValue(undefined),
        };
        const trendingService = {
            isAvailable: false,
            items: signal([]),
            loading: signal(false),
            load: jest.fn().mockResolvedValue(undefined),
        };
        const recommendationsService = {
            isAvailable: false,
            items: signal([]),
            seedTitles: signal([]),
            loading: signal(false),
            load: jest.fn().mockResolvedValue(undefined),
        };
        const liveEpg = {
            connect: jest.fn(),
            enrich: jest.fn((items: readonly unknown[]) => items),
            setVisibleCards: jest.fn(),
        };

        await TestBed.configureTestingModule({
            imports: [
                WorkspaceDashboardRailsComponent,
                TranslateModule.forRoot(),
            ],
            providers: [
                provideRouter([]),
                { provide: DashboardDataService, useValue: data },
                {
                    provide: RuntimeCapabilitiesService,
                    useValue: { isElectron },
                },
                {
                    provide: SettingsStore,
                    useValue: { dashboardRails: signal(rails) },
                },
                {
                    provide: DashboardSourceExpiryService,
                    useValue: {
                        facts: signal(new Map()),
                        refresh: jest.fn().mockResolvedValue(undefined),
                    },
                },
                {
                    provide: DashboardTrendingService,
                    useValue: trendingService,
                },
                {
                    provide: DashboardRecommendationsService,
                    useValue: recommendationsService,
                },
                { provide: MatDialog, useValue: { open: jest.fn() } },
                { provide: MatSnackBar, useValue: { open: jest.fn() } },
                {
                    provide: DialogService,
                    useValue: { openConfirmDialog: jest.fn() },
                },
                {
                    provide: PlaylistDeleteActionService,
                    useValue: { deletePlaylist: jest.fn() },
                },
                {
                    provide: PlaylistRefreshActionService,
                    useValue: { canRefresh: jest.fn(), refresh: jest.fn() },
                },
                { provide: Store, useValue: { dispatch: jest.fn() } },
                {
                    provide: WORKSPACE_SHELL_ACTIONS,
                    useValue: {
                        openAddPlaylistDialog: jest.fn(),
                        openAccountInfo: jest.fn(),
                        openStalkerAccountInfo: jest.fn(),
                    },
                },
            ],
        })
            .overrideComponent(WorkspaceDashboardRailsComponent, {
                set: {
                    imports: [
                        DashboardHeroStubComponent,
                        DashboardRailStubComponent,
                        DashboardRailSkeletonStubComponent,
                        EmptyStateStubComponent,
                        TranslatePipe,
                    ],
                    providers: [
                        {
                            provide: DashboardLiveEpgPresenter,
                            useValue: liveEpg,
                        },
                    ],
                },
            })
            .compileComponents();

        const fixture = TestBed.createComponent(
            WorkspaceDashboardRailsComponent
        );
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        return {
            fixture,
            railStubs: () =>
                fixture.debugElement
                    .queryAll(By.directive(DashboardRailStubComponent))
                    .map(
                        (element) =>
                            element.componentInstance as DashboardRailStubComponent
                    ),
        };
    }

    afterEach(() => TestBed.resetTestingModule());

    it('places the trends carousel before recent movies, recent series and Continue watching in the PWA', async () => {
        const { fixture, railStubs } = await render(false);
        const order = Array.from(
            (
                fixture.nativeElement as HTMLElement
            ).querySelectorAll<HTMLElement>(
                '[data-test-id="dashboard-zenplay-trending-hero"], [data-test-id$="-rail"]'
            )
        ).map((element) => element.dataset['testId']);

        expect(order).toEqual([
            'dashboard-zenplay-trending-hero',
            'dashboard-zenplay-recent-movies-rail',
            'dashboard-zenplay-recent-series-rail',
            'dashboard-continue-watching-rail',
        ]);
        expect(railStubs().map((rail) => rail.label)).toEqual([
            'WORKSPACE.DASHBOARD.ZENPLAY_RECENT_MOVIES',
            'WORKSPACE.DASHBOARD.ZENPLAY_RECENT_SERIES',
            'WORKSPACE.DASHBOARD.CONTINUE_WATCHING',
        ]);
        expect(railStubs().map((rail) => rail.testId)).not.toContain(
            'dashboard-zenplay-trending-rail'
        );
    });

    it('keeps Electron on the existing mixed recently-added row', async () => {
        const { fixture, railStubs } = await render(true);
        const testIds = railStubs().map((rail) => rail.testId);

        expect(
            (fixture.nativeElement as HTMLElement).querySelector(
                '[data-test-id="dashboard-zenplay-trending-hero"]'
            )
        ).toBeNull();
        expect(testIds).not.toContain('dashboard-zenplay-trending-rail');
        expect(testIds).not.toContain('dashboard-zenplay-recent-movies-rail');
        expect(testIds).not.toContain('dashboard-zenplay-recent-series-rail');
        expect(testIds).toContain('dashboard-xtream-recently-added-rail');

        const mixed = railStubs().find(
            (rail) => rail.testId === 'dashboard-xtream-recently-added-rail'
        );
        expect(
            mixed?.items.map(
                (item) => (item as { contentType?: string }).contentType
            )
        ).toEqual(['movie', 'series']);
    });
});
