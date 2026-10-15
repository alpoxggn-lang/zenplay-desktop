import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    OnInit,
    signal,
    untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { map } from 'rxjs/operators';
import {
    GridListComponent,
    InfiniteScrollDirective,
} from '@iptvnator/portal/shared/ui';
import { XtreamStore } from '@iptvnator/portal/xtream/data-access';
import { buildXtreamNavigationTarget } from '@iptvnator/portal/shared/util';
import {
    DatabaseService,
    type GlobalRecentlyAddedItem,
    ParentalLockService,
    RuntimeCapabilitiesService,
} from '@iptvnator/services';

type RecentlyAddedCollectionKind = 'vod' | 'series';
type RecentlyAddedGridItem = GlobalRecentlyAddedItem & Record<string, unknown>;

const PAGE_SIZE = 48;

@Component({
    selector: 'app-recently-added-collection',
    templateUrl: './recently-added-collection.component.html',
    styleUrl: './recently-added-collection.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [GridListComponent, InfiniteScrollDirective, TranslatePipe],
})
export class RecentlyAddedCollectionComponent implements OnInit {
    private readonly activatedRoute = inject(ActivatedRoute);
    private readonly database = inject(DatabaseService);
    private readonly parentalLock = inject(ParentalLockService);
    private readonly router = inject(Router);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly xtreamStore = inject(XtreamStore);
    private readonly allItemsState = signal<GlobalRecentlyAddedItem[]>([]);
    private readonly seenItemKeys = new Set<string>();
    private loadInFlight = false;
    private reloadAfterCurrent = false;
    private initialized = false;
    private loadGeneration = 0;
    private offset = 0;
    private observedLockVersion = this.parentalLock.version();
    private observedWithholdsEverything =
        this.parentalLock.withholdsEverything();
    private observedContentLoadState =
        this.xtreamStore.contentLoadStateByType()[this.resolveKind()];
    private contentRefreshPending = false;

    readonly kind = this.resolveKind();
    readonly titleKey =
        this.kind === 'series'
            ? 'WORKSPACE.DASHBOARD.ZENPLAY_RECENT_SERIES'
            : 'WORKSPACE.DASHBOARD.ZENPLAY_RECENT_MOVIES';
    readonly gridType = this.kind === 'series' ? 'series' : 'vod';
    readonly isLoading = signal(true);
    readonly isAppending = signal(false);
    readonly appendError = signal(false);
    readonly hasMore = signal(true);
    private readonly loadedLockVersion = signal<number | null>(null);
    readonly searchTerm = toSignal(
        this.activatedRoute.queryParamMap.pipe(
            map((params) => params.get('q')?.trim() ?? '')
        ),
        { initialValue: '' }
    );
    private observedSearchTerm = this.searchTerm();
    private observedImportSessionId = this.xtreamStore.activeImportSessionId();
    readonly items = computed(() => {
        const lockVersion = this.parentalLock.version();
        if (
            this.parentalLock.withholdsEverything() ||
            this.loadedLockVersion() !== lockVersion
        ) {
            return [];
        }
        return this.allItemsState();
    });
    readonly gridItems = computed<RecentlyAddedGridItem[]>(() =>
        this.items().map((item) => ({ ...item }) as RecentlyAddedGridItem)
    );
    readonly loadedCount = computed(() =>
        this.parentalLock.withholdsEverything() ||
        this.loadedLockVersion() !== this.parentalLock.version()
            ? 0
            : this.allItemsState().length
    );
    readonly resetKey = computed(() => `${this.kind}|${this.searchTerm()}`);

    constructor() {
        effect(() => {
            const lockVersion = this.parentalLock.version();
            const withholdsEverything = this.parentalLock.withholdsEverything();
            untracked(() => {
                if (!this.initialized) {
                    this.observedLockVersion = lockVersion;
                    this.observedWithholdsEverything = withholdsEverything;
                    return;
                }
                if (
                    lockVersion === this.observedLockVersion &&
                    withholdsEverything === this.observedWithholdsEverything
                ) {
                    return;
                }

                this.observedLockVersion = lockVersion;
                this.observedWithholdsEverything = withholdsEverything;
                this.reloadCollection();
            });
        });

        effect(() => {
            const searchTerm = this.searchTerm();
            const importSessionId = this.xtreamStore.activeImportSessionId();
            const contentLoadState =
                this.xtreamStore.contentLoadStateByType()[this.kind];
            const contentInitialized = this.xtreamStore.isContentInitialized();
            const restoreBlocked = this.xtreamStore.isPendingRestoreBlocked();
            const initBlockReason = this.xtreamStore.contentInitBlockReason();
            untracked(() => {
                if (!this.initialized) {
                    this.observedSearchTerm = searchTerm;
                    this.observedImportSessionId = importSessionId;
                    this.observedContentLoadState = contentLoadState;
                    return;
                }

                const searchChanged = searchTerm !== this.observedSearchTerm;
                const importSessionCompleted =
                    this.observedImportSessionId !== null &&
                    importSessionId === null;
                const contentBecameReady =
                    this.observedContentLoadState !== 'ready' &&
                    contentLoadState === 'ready';
                if (importSessionCompleted || contentBecameReady) {
                    this.contentRefreshPending = true;
                }
                const contentRefreshCompleted =
                    this.contentRefreshPending &&
                    importSessionId === null &&
                    contentInitialized &&
                    contentLoadState === 'ready' &&
                    !restoreBlocked &&
                    initBlockReason === null;
                this.observedSearchTerm = searchTerm;
                this.observedImportSessionId = importSessionId;
                this.observedContentLoadState = contentLoadState;

                if (contentRefreshCompleted) {
                    this.contentRefreshPending = false;
                }
                if (searchChanged || contentRefreshCompleted) {
                    this.reloadCollection();
                }
            });
        });
    }

    ngOnInit(): void {
        this.initialized = true;
        if (this.parentalLock.withholdsEverything()) {
            this.isLoading.set(false);
            return;
        }
        void this.loadNextPage();
    }

    onLoadMore(): void {
        void this.loadNextPage();
    }

    retryLoadMore(): void {
        void this.loadNextPage();
    }

    async loadNextPage(): Promise<void> {
        if (this.loadInFlight) {
            return;
        }
        if (
            !this.runtime.supportsPortalActivityStorage ||
            this.parentalLock.withholdsEverything() ||
            !this.hasMore()
        ) {
            this.isLoading.set(false);
            return;
        }

        this.loadInFlight = true;
        const loadGeneration = this.loadGeneration;
        const lockVersion = this.parentalLock.version();
        const initial = this.offset === 0;
        this.appendError.set(false);
        this.isAppending.set(!initial);

        try {
            let added = 0;
            do {
                const searchTerm = this.searchTerm();
                const page = searchTerm
                    ? await this.database.getGlobalRecentlyAddedPage(
                          this.kind,
                          PAGE_SIZE,
                          'xtream',
                          this.offset,
                          searchTerm
                      )
                    : await this.database.getGlobalRecentlyAddedPage(
                          this.kind,
                          PAGE_SIZE,
                          'xtream',
                          this.offset
                      );
                if (
                    loadGeneration !== this.loadGeneration ||
                    lockVersion !== this.parentalLock.version() ||
                    this.parentalLock.withholdsEverything()
                ) {
                    return;
                }
                this.offset += page.length;
                this.hasMore.set(page.length === PAGE_SIZE);
                added = this.appendUnique(page);
                this.loadedLockVersion.set(lockVersion);
            } while (added === 0 && this.hasMore());
        } catch {
            this.appendError.set(true);
            this.hasMore.set(true);
        } finally {
            this.loadInFlight = false;
            this.isLoading.set(false);
            this.isAppending.set(false);
            if (this.reloadAfterCurrent) {
                this.reloadAfterCurrent = false;
                if (!this.parentalLock.withholdsEverything()) {
                    this.isLoading.set(true);
                    void this.loadNextPage();
                }
            }
        }
    }

    openItem(item: GlobalRecentlyAddedItem): void {
        const navigation = buildXtreamNavigationTarget({
            playlistId: item.playlist_id,
            type: item.type === 'series' ? 'series' : 'movie',
            categoryId: item.category_id,
            itemId: item.xtream_id,
            title: item.title,
            imageUrl: item.poster_url,
        });
        void this.router.navigate(navigation.link, {
            state: navigation.state,
        });
    }

    private appendUnique(page: readonly GlobalRecentlyAddedItem[]): number {
        const unique: GlobalRecentlyAddedItem[] = [];
        for (const item of page) {
            const key = `${item.playlist_id}:${item.type}:${item.xtream_id}`;
            if (this.seenItemKeys.has(key)) continue;
            this.seenItemKeys.add(key);
            unique.push(item);
        }

        if (unique.length > 0) {
            this.allItemsState.update((current) => [...current, ...unique]);
        }
        return unique.length;
    }

    private reloadCollection(): void {
        this.resetCollection();
        if (this.parentalLock.withholdsEverything()) {
            this.reloadAfterCurrent = false;
            this.isLoading.set(false);
            return;
        }

        this.isLoading.set(true);
        if (this.loadInFlight) {
            this.reloadAfterCurrent = true;
            return;
        }
        void this.loadNextPage();
    }

    private resetCollection(): void {
        this.loadGeneration += 1;
        this.offset = 0;
        this.seenItemKeys.clear();
        this.allItemsState.set([]);
        this.loadedLockVersion.set(null);
        this.hasMore.set(true);
        this.appendError.set(false);
        this.isAppending.set(false);
    }

    private resolveKind(): RecentlyAddedCollectionKind {
        return this.activatedRoute.snapshot.data['recentlyAddedKind'] ===
            'series'
            ? 'series'
            : 'vod';
    }
}
