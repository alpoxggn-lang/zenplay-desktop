import {
    computed,
    DestroyRef,
    inject,
    Injectable,
    signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatSnackBar } from '@angular/material/snack-bar';
import { NavigationEnd, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import {
    XTREAM_DATA_SOURCE,
    XtreamStore,
} from '@iptvnator/portal/xtream/data-access';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import { DashboardDataService } from '@iptvnator/workspace/dashboard/data-access';
import { filter } from 'rxjs';
import { ZENPLAY_PLAYLIST_ID } from '../zenplay-auth/zenplay.constants';

export const ZENPLAY_CONTENT_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const ZENPLAY_DASHBOARD_CATALOG_LIMIT = 300;

/**
 * Keeps the managed ZenPlay web catalog current without deleting favorites,
 * history, profiles or playback progress. PWA catalog rows are session-cached,
 * so a refresh first invalidates only that cache and then reads the provider
 * again. A single in-flight promise coalesces the header button, app entry and
 * the two-hour timer.
 */
@Injectable({ providedIn: 'root' })
export class ZenPlayContentRefreshService {
    private readonly dashboard = inject(DashboardDataService);
    private readonly dataSource = inject(XTREAM_DATA_SOURCE);
    private readonly destroyRef = inject(DestroyRef);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly router = inject(Router);
    private readonly snackBar = inject(MatSnackBar);
    private readonly translate = inject(TranslateService);
    private readonly xtreamStore = inject(XtreamStore);

    private readonly refreshingState = signal(false);
    readonly refreshing = this.refreshingState.asReadonly();
    readonly canRefresh = computed(
        () =>
            this.runtime.isPwa &&
            this.dashboard
                .playlists()
                .some(
                    (playlist) =>
                        playlist._id === ZENPLAY_PLAYLIST_ID &&
                        Boolean(playlist.serverUrl) &&
                        Boolean(playlist.username) &&
                        Boolean(playlist.password)
                )
    );

    private inFlight: Promise<void> | null = null;
    private automaticRefreshStarted = false;
    private lastRefreshStartedAt = 0;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private pendingStoreResetPlaylistId: string | null = null;

    constructor() {
        this.router.events
            .pipe(
                filter(
                    (event): event is NavigationEnd =>
                        event instanceof NavigationEnd
                ),
                takeUntilDestroyed()
            )
            .subscribe((event) => {
                if (
                    event.urlAfterRedirects.startsWith('/workspace/dashboard')
                ) {
                    this.resetDeferredPortalStore();
                }
            });
    }

    startAutomaticRefresh(): void {
        if (
            this.automaticRefreshStarted ||
            !this.runtime.isPwa ||
            typeof window === 'undefined'
        ) {
            return;
        }

        this.automaticRefreshStarted = true;
        void this.refresh();
        this.intervalId = window.setInterval(
            () => void this.refreshIfDue(),
            ZENPLAY_CONTENT_REFRESH_INTERVAL_MS
        );

        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                void this.refreshIfDue();
            }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        this.destroyRef.onDestroy(() => {
            if (this.intervalId !== null) {
                clearInterval(this.intervalId);
            }
            document.removeEventListener(
                'visibilitychange',
                onVisibilityChange
            );
        });
    }

    refresh(options: { announce?: boolean } = {}): Promise<void> {
        if (!this.canRefresh()) {
            return Promise.resolve();
        }
        if (this.inFlight) {
            return this.inFlight;
        }

        this.lastRefreshStartedAt = Date.now();
        this.refreshingState.set(true);
        const work = this.refreshProviderCatalog(options.announce === true);
        this.inFlight = work.finally(() => {
            this.inFlight = null;
            this.refreshingState.set(false);
        });
        return this.inFlight;
    }

    private refreshIfDue(): Promise<void> {
        return Date.now() - this.lastRefreshStartedAt >=
            ZENPLAY_CONTENT_REFRESH_INTERVAL_MS
            ? this.refresh()
            : Promise.resolve();
    }

    private async refreshProviderCatalog(announce: boolean): Promise<void> {
        const playlists = this.dashboard
            .playlists()
            .filter(
                (playlist) =>
                    playlist._id === ZENPLAY_PLAYLIST_ID &&
                    Boolean(playlist.serverUrl) &&
                    Boolean(playlist.username) &&
                    Boolean(playlist.password)
            );

        for (const playlist of playlists) {
            this.dataSource.clearSessionCache(playlist._id);
        }

        // Movies and series repopulate the shared PWA cache first. The
        // history/favorites hydration and any open portal view can then reuse
        // those rows instead of issuing duplicate full-catalog requests.
        await this.dashboard.reloadXtreamRecentlyAddedItems(
            ZENPLAY_DASHBOARD_CATALOG_LIMIT
        );
        await Promise.all([
            this.dashboard.reloadGlobalRecentItems(),
            this.dashboard.reloadGlobalFavorites(),
        ]);
        this.invalidateOpenPortalStore(playlists.map((item) => item._id));

        if (announce) {
            this.snackBar.open(
                this.translate.instant(
                    'HOME.PLAYLISTS.PLAYLIST_UPDATE_SUCCESS'
                ),
                undefined,
                { duration: 2500 }
            );
        }
    }

    private invalidateOpenPortalStore(playlistIds: readonly string[]): void {
        const currentId = this.xtreamStore.currentPlaylist()?.id;
        if (!currentId || !playlistIds.includes(currentId)) {
            return;
        }

        if (this.router.url.startsWith('/workspace/dashboard')) {
            this.xtreamStore.resetStore(currentId);
            this.pendingStoreResetPlaylistId = null;
            return;
        }

        // Never replace catalog arrays underneath an active detail/player.
        // Inicio is already fresh; invalidate the portal store once navigation
        // returns to the safe dashboard surface.
        this.pendingStoreResetPlaylistId = currentId;
    }

    private resetDeferredPortalStore(): void {
        const playlistId = this.pendingStoreResetPlaylistId;
        if (!playlistId) {
            return;
        }
        if (this.xtreamStore.currentPlaylist()?.id === playlistId) {
            this.xtreamStore.resetStore(playlistId);
        }
        this.pendingStoreResetPlaylistId = null;
    }
}
