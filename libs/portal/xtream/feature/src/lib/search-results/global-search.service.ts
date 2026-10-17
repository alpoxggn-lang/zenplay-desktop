import { inject, Injectable } from '@angular/core';
import {
    DatabaseService,
    ParentalLockService,
    PlaylistsService,
    RuntimeCapabilitiesService,
} from '@iptvnator/services';
import {
    IXtreamDataSource,
    XTREAM_DATA_SOURCE,
    XtreamContentItem,
} from '@iptvnator/portal/xtream/data-access';
import {
    foldSearchText,
    GlobalSearchContentType,
    GlobalSearchPaginationOptions,
    GlobalSearchResult,
    GLOBAL_SEARCH_CONTENT_TYPES,
    GLOBAL_SEARCH_RESULT_SOURCES,
    PlaylistMeta,
    XtreamGlobalSearchResult,
} from '@iptvnator/shared/interfaces';
import { firstValueFrom } from 'rxjs';
import { createInFlightXtreamCatalogLoader } from './in-flight-xtream-catalog-loader';
import {
    readM3uChannels,
    scoreM3uChannel,
    toM3uGlobalSearchResult,
} from './m3u-global-search';
import {
    createPwaGlobalSearchSessionKey,
    PwaGlobalSearchSessionCache,
} from './pwa-global-search-session-cache';

interface SearchCandidate {
    result: GlobalSearchResult;
    score: number;
}

interface FailedLoad {
    error: unknown;
}

@Injectable({ providedIn: 'root' })
export class GlobalSearchService {
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly database = inject(DatabaseService);
    private readonly playlists = inject(PlaylistsService);
    private readonly parentalLock = inject(ParentalLockService);
    private readonly xtreamDataSource = inject(XTREAM_DATA_SOURCE);
    private readonly loadXtreamCatalog = createInFlightXtreamCatalogLoader(
        this.xtreamDataSource
    );
    private readonly pwaSearchSessions = new PwaGlobalSearchSessionCache<
        SearchCandidate[]
    >();
    private pwaSearchLockVersion: number | null = null;

    /** Lets the active results view react immediately to lock/rule changes. */
    readonly parentalLockVersion = this.parentalLock.version;

    get supportsHiddenCategoryFilter(): boolean {
        return this.runtime.isElectron;
    }
    globalSearchContent(
        searchTerm: string,
        types: string[],
        excludeHidden?: boolean,
        options?: GlobalSearchPaginationOptions
    ): Promise<GlobalSearchResult[]> {
        if (this.runtime.isElectron) {
            return this.database.globalSearchContent(
                searchTerm,
                types,
                excludeHidden,
                undefined,
                options
            );
        }

        return this.searchPwa(searchTerm, types, excludeHidden, options);
    }

    private async searchPwa(
        searchTerm: string,
        types: string[],
        excludeHidden = false,
        options?: GlobalSearchPaginationOptions
    ): Promise<GlobalSearchResult[]> {
        const normalizedTypes = normalizeContentTypes(types);
        const term = searchTerm.trim();
        if (term.length === 0 || normalizedTypes.length === 0) {
            return [];
        }

        const offset = normalizePositiveInteger(options?.offset, 0);

        // The lock can engage while provider requests are still in flight.
        // Rebuild snapshots created under an older version, then synchronously
        // revalidate at the publication boundary before any row reaches UI.
        for (;;) {
            const lockVersion = this.parentalLock.version();
            this.syncPwaSearchLockVersion(lockVersion);
            const sessionKey = createPwaGlobalSearchSessionKey(
                term,
                normalizedTypes,
                excludeHidden,
                lockVersion
            );
            const candidates = await this.pwaSearchSessions.get(
                sessionKey,
                offset === 0,
                () =>
                    this.loadPwaSearchCandidates(
                        term,
                        normalizedTypes,
                        excludeHidden
                    )
            );

            if (this.parentalLock.version() !== lockVersion) {
                this.pwaSearchSessions.clear();
                continue;
            }

            const visibleCandidates = candidates.filter((candidate) =>
                this.isAllowedByCurrentParentalLock(candidate.result)
            );
            const limit = normalizePositiveInteger(
                options?.limit,
                visibleCandidates.length
            );
            return visibleCandidates
                .slice(offset, offset + limit)
                .map((candidate) => candidate.result);
        }
    }

    private async loadPwaSearchCandidates(
        term: string,
        normalizedTypes: GlobalSearchContentType[],
        excludeHidden: boolean
    ): Promise<SearchCandidate[]> {
        const playlistMetas = (await firstValueFrom(
            this.playlists.getAllPlaylists()
        )) as PlaylistMeta[];
        const searchablePlaylists = playlistMetas.filter(
            (playlist) =>
                isXtreamPlaylist(playlist) ||
                (isM3uPlaylist(playlist) &&
                    normalizedTypes.includes(GLOBAL_SEARCH_CONTENT_TYPES.Live))
        );
        if (searchablePlaylists.length === 0) return [];

        const sourceResults = await Promise.all(
            searchablePlaylists.map((playlist) =>
                captureFailure(
                    this.searchPwaPlaylist(
                        playlist,
                        term,
                        normalizedTypes,
                        excludeHidden
                    )
                )
            )
        );
        const successfulSources = sourceResults.filter(
            (result): result is SearchCandidate[] => Array.isArray(result)
        );
        if (successfulSources.length === 0) {
            throw (sourceResults[0] as FailedLoad).error;
        }
        const candidates: SearchCandidate[] = [];
        for (const sourceResult of successfulSources) {
            candidates.push(...sourceResult);
        }

        const deduplicatedCandidates = deduplicateCandidates(candidates);
        deduplicatedCandidates.sort(
            (left, right) =>
                left.score - right.score ||
                left.result.title.localeCompare(right.result.title) ||
                left.result.playlist_name.localeCompare(
                    right.result.playlist_name
                )
        );

        return deduplicatedCandidates;
    }

    private syncPwaSearchLockVersion(lockVersion: number): void {
        if (this.pwaSearchLockVersion === lockVersion) return;
        this.pwaSearchSessions.clear();
        this.pwaSearchLockVersion = lockVersion;
    }

    private isAllowedByCurrentParentalLock(
        result: GlobalSearchResult
    ): boolean {
        const playlistId = String(result.playlist_id ?? '').trim();
        if (!playlistId) return false;
        if (!this.parentalLock.active()) return true;
        if (this.parentalLock.withholdsEverything()) return false;

        if (result.source_type === GLOBAL_SEARCH_RESULT_SOURCES.M3u) {
            return !this.parentalLock.isM3uGroupLocked(
                playlistId,
                result.group_title
            );
        }

        const categoryType =
            result.type === GLOBAL_SEARCH_CONTENT_TYPES.Movie
                ? 'movies'
                : result.type;
        const categoryId = Number(result.category_id);
        if (!Number.isFinite(categoryId)) return false;
        return !this.parentalLock.isXtreamCategoryLocked(
            playlistId,
            categoryType,
            categoryId
        );
    }

    private searchPwaPlaylist(
        playlist: PlaylistMeta,
        term: string,
        types: GlobalSearchContentType[],
        excludeHidden: boolean
    ): Promise<SearchCandidate[]> {
        if (isXtreamPlaylist(playlist)) {
            return searchPwaXtreamPlaylist(
                this.xtreamDataSource,
                this.loadXtreamCatalog,
                playlist,
                term,
                types,
                excludeHidden
            );
        }

        if (
            isM3uPlaylist(playlist) &&
            types.includes(GLOBAL_SEARCH_CONTENT_TYPES.Live)
        ) {
            return this.searchPwaM3uPlaylist(playlist, term, excludeHidden);
        }

        return Promise.resolve([]);
    }

    private async searchPwaM3uPlaylist(
        playlistMeta: PlaylistMeta,
        term: string,
        excludeHidden: boolean
    ): Promise<SearchCandidate[]> {
        const playlist = await firstValueFrom(
            this.playlists.getPlaylist(playlistMeta._id)
        );
        if (!playlist) {
            return [];
        }

        const hiddenGroups = new Set(playlist.hiddenGroupTitles ?? []);
        const candidates: SearchCandidate[] = [];
        for (const channel of readM3uChannels(playlist)) {
            if (
                this.parentalLock.isM3uGroupLocked(
                    playlistMeta._id,
                    channel.group.title
                )
            ) {
                continue;
            }
            if (excludeHidden && hiddenGroups.has(channel.group.title)) {
                continue;
            }

            const score = scoreM3uChannel(channel, term);
            if (score !== null) {
                candidates.push({
                    result: toM3uGlobalSearchResult(playlistMeta, channel),
                    score,
                });
            }
        }
        return candidates;
    }
}

function isXtreamPlaylist(playlist: PlaylistMeta): boolean {
    return Boolean(playlist.serverUrl) && !playlist.macAddress;
}

function isM3uPlaylist(playlist: PlaylistMeta): boolean {
    return !playlist.serverUrl && !playlist.macAddress;
}

function normalizeContentTypes(types: string[]): GlobalSearchContentType[] {
    return [
        ...new Set(
            types.filter(
                (type): type is GlobalSearchContentType =>
                    type === GLOBAL_SEARCH_CONTENT_TYPES.Live ||
                    type === GLOBAL_SEARCH_CONTENT_TYPES.Movie ||
                    type === GLOBAL_SEARCH_CONTENT_TYPES.Series
            )
        ),
    ];
}

function deduplicateCandidates(
    candidates: SearchCandidate[]
): SearchCandidate[] {
    const candidatesById = new Map<string, SearchCandidate>();
    for (const candidate of candidates) {
        const key = String(candidate.result.id);
        const current = candidatesById.get(key);
        if (!current || candidate.score < current.score) {
            candidatesById.set(key, candidate);
        }
    }
    return [...candidatesById.values()];
}

async function searchPwaXtreamPlaylist(
    dataSource: IXtreamDataSource,
    loadContent: (
        playlistId: string,
        credentials: Parameters<IXtreamDataSource['getContent']>[1],
        type: GlobalSearchContentType
    ) => Promise<unknown>,
    playlistMeta: PlaylistMeta,
    term: string,
    types: GlobalSearchContentType[],
    excludeHidden: boolean
): Promise<SearchCandidate[]> {
    const playlist = await dataSource.getPlaylist(playlistMeta._id);
    if (!playlist) {
        return [];
    }

    const credentials = {
        serverUrl: playlist.serverUrl,
        username: playlist.username,
        password: playlist.password,
    };
    const contentLoads = await Promise.all(
        types.map((type) =>
            captureFailure(
                loadContent(playlistMeta._id, credentials, type).then(
                    () => type
                )
            )
        )
    );
    const availableTypes = contentLoads.filter(
        (result): result is GlobalSearchContentType =>
            typeof result === 'string'
    );
    if (availableTypes.length === 0) {
        throw (contentLoads[0] as FailedLoad).error;
    }

    const matches = await dataSource.searchContent(
        playlistMeta._id,
        term,
        availableTypes,
        excludeHidden
    );
    const candidates: SearchCandidate[] = [];
    for (const item of matches) {
        const result = toXtreamGlobalSearchResult(playlistMeta, item);
        const score = scoreText(result.title, term);
        if (score !== null) {
            candidates.push({ result, score });
        }
    }
    return candidates;
}

function toXtreamGlobalSearchResult(
    playlist: PlaylistMeta,
    item: XtreamContentItem
): XtreamGlobalSearchResult {
    const type = normalizeItemType(item.type);
    return {
        ...item,
        source_type: GLOBAL_SEARCH_RESULT_SOURCES.Xtream,
        content_type: type,
        id: `${playlist._id}:${type}:${item.xtream_id}`,
        category_id: item.category_id,
        title: item.title,
        rating: item.rating || null,
        added: item.added || null,
        poster_url: item.poster_url || null,
        xtream_id: item.xtream_id,
        type,
        playlist_id: playlist._id,
        playlist_name: playlist.title,
    };
}

function normalizeItemType(type: string): GlobalSearchContentType {
    if (type === 'series') return GLOBAL_SEARCH_CONTENT_TYPES.Series;
    if (type === 'live') return GLOBAL_SEARCH_CONTENT_TYPES.Live;
    return GLOBAL_SEARCH_CONTENT_TYPES.Movie;
}

function scoreText(value: string, term: string): number | null {
    const text = foldSearchText(value);
    const query = foldSearchText(term);
    if (!query || !text.includes(query)) return null;
    if (text === query) return 0;
    if (text.startsWith(query)) return 1;
    return 2;
}

function normalizePositiveInteger(
    value: number | undefined,
    fallback: number
): number {
    return Number.isFinite(value)
        ? Math.max(0, Math.trunc(value as number))
        : fallback;
}

function captureFailure<T>(promise: Promise<T>): Promise<T | FailedLoad> {
    return promise.catch((error: unknown) => ({ error }));
}
