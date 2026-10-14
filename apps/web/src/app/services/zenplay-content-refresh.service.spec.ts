import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { NavigationEnd, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import {
    XTREAM_DATA_SOURCE,
    XtreamStore,
} from '@iptvnator/portal/xtream/data-access';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import { DashboardDataService } from '@iptvnator/workspace/dashboard/data-access';
import { Subject } from 'rxjs';
import {
    ZENPLAY_CONTENT_REFRESH_INTERVAL_MS,
    ZenPlayContentRefreshService,
} from './zenplay-content-refresh.service';

describe('ZenPlayContentRefreshService', () => {
    const playlist = {
        _id: 'zenplay-primary',
        serverUrl: 'https://provider.example',
        username: 'user',
        password: 'secret',
    };

    let service: ZenPlayContentRefreshService;
    let playlists: ReturnType<typeof signal<Array<typeof playlist>>>;
    let dashboard: {
        playlists: ReturnType<typeof signal<Array<typeof playlist>>>;
        reloadXtreamRecentlyAddedItems: jest.Mock;
        reloadGlobalRecentItems: jest.Mock;
        reloadGlobalFavorites: jest.Mock;
    };
    let dataSource: { clearSessionCache: jest.Mock };
    let xtreamStore: {
        currentPlaylist: ReturnType<typeof signal<{ id: string } | null>>;
        resetStore: jest.Mock;
    };
    let snackBar: { open: jest.Mock };
    let runtime: { isPwa: boolean };
    let routerEvents: Subject<NavigationEnd>;
    let router: { url: string; events: Subject<NavigationEnd> };

    beforeEach(() => {
        jest.useFakeTimers();
        playlists = signal([playlist]);
        dashboard = {
            playlists,
            reloadXtreamRecentlyAddedItems: jest
                .fn()
                .mockResolvedValue(undefined),
            reloadGlobalRecentItems: jest.fn().mockResolvedValue(undefined),
            reloadGlobalFavorites: jest.fn().mockResolvedValue(undefined),
        };
        dataSource = { clearSessionCache: jest.fn() };
        xtreamStore = {
            currentPlaylist: signal({ id: playlist._id }),
            resetStore: jest.fn(),
        };
        snackBar = { open: jest.fn() };
        runtime = { isPwa: true };
        routerEvents = new Subject<NavigationEnd>();
        router = { url: '/workspace/dashboard', events: routerEvents };

        TestBed.configureTestingModule({
            providers: [
                ZenPlayContentRefreshService,
                { provide: DashboardDataService, useValue: dashboard },
                { provide: XTREAM_DATA_SOURCE, useValue: dataSource },
                { provide: XtreamStore, useValue: xtreamStore },
                { provide: RuntimeCapabilitiesService, useValue: runtime },
                { provide: Router, useValue: router },
                { provide: MatSnackBar, useValue: snackBar },
                {
                    provide: TranslateService,
                    useValue: { instant: jest.fn((key: string) => key) },
                },
            ],
        });
        service = TestBed.inject(ZenPlayContentRefreshService);
    });

    afterEach(() => {
        TestBed.resetTestingModule();
        jest.useRealTimers();
    });

    it('refreshes the provider catalog manually and announces completion', async () => {
        expect(service.canRefresh()).toBe(true);

        await service.refresh({ announce: true });

        expect(dataSource.clearSessionCache).toHaveBeenCalledWith(playlist._id);
        expect(dashboard.reloadXtreamRecentlyAddedItems).toHaveBeenCalledWith(
            300
        );
        expect(dashboard.reloadGlobalRecentItems).toHaveBeenCalledTimes(1);
        expect(dashboard.reloadGlobalFavorites).toHaveBeenCalledTimes(1);
        expect(xtreamStore.resetStore).toHaveBeenCalledWith(playlist._id);
        expect(snackBar.open).toHaveBeenCalledWith(
            'HOME.PLAYLISTS.PLAYLIST_UPDATE_SUCCESS',
            undefined,
            { duration: 2500 }
        );
        expect(service.refreshing()).toBe(false);
    });

    it('coalesces concurrent refresh requests into one provider reload', async () => {
        let finish!: () => void;
        dashboard.reloadXtreamRecentlyAddedItems.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                finish = resolve;
            })
        );

        const first = service.refresh();
        const second = service.refresh({ announce: true });

        expect(second).toBe(first);
        expect(service.refreshing()).toBe(true);
        expect(dataSource.clearSessionCache).toHaveBeenCalledTimes(1);

        finish();
        await first;

        expect(dashboard.reloadXtreamRecentlyAddedItems).toHaveBeenCalledTimes(
            1
        );
        expect(service.refreshing()).toBe(false);
        // The first caller owns the coalesced operation's options.
        expect(snackBar.open).not.toHaveBeenCalled();
    });

    it('starts with an immediate refresh and repeats it every two hours', async () => {
        service.startAutomaticRefresh();
        await jest.advanceTimersByTimeAsync(0);

        expect(dashboard.reloadXtreamRecentlyAddedItems).toHaveBeenCalledTimes(
            1
        );

        await jest.advanceTimersByTimeAsync(
            ZENPLAY_CONTENT_REFRESH_INTERVAL_MS
        );

        expect(dashboard.reloadXtreamRecentlyAddedItems).toHaveBeenCalledTimes(
            2
        );

        service.startAutomaticRefresh();
        await jest.advanceTimersByTimeAsync(
            ZENPLAY_CONTENT_REFRESH_INTERVAL_MS
        );
        expect(dashboard.reloadXtreamRecentlyAddedItems).toHaveBeenCalledTimes(
            3
        );
    });

    it('refreshes on a visible return only when the two-hour interval is due', async () => {
        service.startAutomaticRefresh();
        await jest.advanceTimersByTimeAsync(0);
        const visibilityState = jest
            .spyOn(document, 'visibilityState', 'get')
            .mockReturnValue('visible');

        document.dispatchEvent(new Event('visibilitychange'));
        await jest.advanceTimersByTimeAsync(0);
        expect(dashboard.reloadXtreamRecentlyAddedItems).toHaveBeenCalledTimes(
            1
        );

        jest.setSystemTime(Date.now() + ZENPLAY_CONTENT_REFRESH_INTERVAL_MS);
        document.dispatchEvent(new Event('visibilitychange'));
        await jest.advanceTimersByTimeAsync(0);

        expect(dashboard.reloadXtreamRecentlyAddedItems).toHaveBeenCalledTimes(
            2
        );
        visibilityState.mockRestore();
    });

    it('does nothing outside the managed PWA and preserves its data', async () => {
        runtime.isPwa = false;

        service.startAutomaticRefresh();
        await service.refresh({ announce: true });
        await jest.advanceTimersByTimeAsync(
            ZENPLAY_CONTENT_REFRESH_INTERVAL_MS
        );

        expect(service.canRefresh()).toBe(false);
        expect(dataSource.clearSessionCache).not.toHaveBeenCalled();
        expect(dashboard.reloadXtreamRecentlyAddedItems).not.toHaveBeenCalled();
        expect(snackBar.open).not.toHaveBeenCalled();
    });

    it('defers resetting an open portal until navigation returns to Inicio', async () => {
        router.url = `/workspace/xtreams/${playlist._id}/vod/42`;

        await service.refresh();
        expect(xtreamStore.resetStore).not.toHaveBeenCalled();

        router.url = '/workspace/dashboard';
        routerEvents.next(
            new NavigationEnd(
                1,
                `/workspace/xtreams/${playlist._id}/vod/42`,
                '/workspace/dashboard'
            )
        );

        expect(xtreamStore.resetStore).toHaveBeenCalledWith(playlist._id);
    });

    it('does not refresh without complete managed-provider credentials', async () => {
        playlists.set([{ ...playlist, password: '' }]);

        await service.refresh();

        expect(service.canRefresh()).toBe(false);
        expect(dataSource.clearSessionCache).not.toHaveBeenCalled();
        expect(dashboard.reloadXtreamRecentlyAddedItems).not.toHaveBeenCalled();
    });
});
