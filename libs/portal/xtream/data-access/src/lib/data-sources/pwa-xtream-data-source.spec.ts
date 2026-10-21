import { TestBed } from '@angular/core/testing';
import { PlaybackPositionData } from '@iptvnator/shared/interfaces';
import { PwaXtreamDataSource } from './pwa-xtream-data-source';
import type { XtreamContentItem } from './xtream-data-source.interface';
import {
    XtreamApiService,
    XtreamCredentials,
} from '../services/xtream-api.service';
import {
    DatabaseService,
    DataService,
    ParentalLockService,
    PlaylistsService,
    USER_DATA_STORAGE,
    XtreamPendingRestoreService,
} from '@iptvnator/services';
import { of } from 'rxjs';
import { PortalStatusType } from '../xtream-state';
import { XTREAM_DATA_SOURCE } from './xtream-data-source.interface';
import {
    createContentTestStore,
    createPendingRestoreServiceMock,
} from '../stores/features/with-content.feature.spec-helpers';

let checkPwaPortalStatusMock: jest.Mock<Promise<PortalStatusType>, []>;
const PwaContentStore = createContentTestStore(() =>
    checkPwaPortalStatusMock()
);

describe('PwaXtreamDataSource', () => {
    let dataSource: PwaXtreamDataSource;
    let apiService: {
        getCategories: jest.Mock;
        getStreams: jest.Mock;
    };
    let playlistsService: {
        getPlaylistById: jest.Mock;
        transformPlaylistMeta: jest.Mock;
    };
    let parentalLock: {
        active: jest.Mock<boolean, []>;
        lockedXtreamIds: jest.Mock<number[], [string, string]>;
        withholdsEverything: jest.Mock<boolean, []>;
    };

    const credentials: XtreamCredentials = {
        serverUrl: 'http://localhost:3211',
        username: 'demo',
        password: 'secret',
    };

    beforeEach(() => {
        localStorage.clear();

        apiService = {
            getCategories: jest.fn().mockResolvedValue([]),
            getStreams: jest.fn(),
        };
        playlistsService = {
            getPlaylistById: jest.fn(() => of(undefined)),
            transformPlaylistMeta: jest.fn(() => of(null)),
        };
        parentalLock = {
            active: jest.fn(() => false),
            lockedXtreamIds: jest.fn(
                (_playlistId: string, _type: string): number[] => []
            ),
            withholdsEverything: jest.fn(() => false),
        };
        checkPwaPortalStatusMock = jest.fn().mockResolvedValue('unavailable');

        TestBed.configureTestingModule({
            providers: [
                PwaXtreamDataSource,
                PwaContentStore,
                {
                    provide: XTREAM_DATA_SOURCE,
                    useExisting: PwaXtreamDataSource,
                },
                { provide: ParentalLockService, useValue: parentalLock },
                {
                    provide: XtreamApiService,
                    useValue: apiService,
                },
                {
                    provide: PlaylistsService,
                    useValue: playlistsService,
                },
                {
                    provide: DatabaseService,
                    useValue: {
                        createOperationId: jest.fn(() => 'pwa-import'),
                    },
                },
                {
                    provide: XtreamPendingRestoreService,
                    useValue: createPendingRestoreServiceMock(),
                },
                {
                    provide: DataService,
                    useValue: {
                        sendIpcEvent: jest
                            .fn()
                            .mockResolvedValue({ success: true }),
                    },
                },
            ],
        });

        dataSource = TestBed.inject(PwaXtreamDataSource);
    });

    afterEach(() => {
        localStorage.clear();
    });

    it('withholds locked categories from catalog reads and search while the lock is active', async () => {
        apiService.getStreams.mockResolvedValue([
            { stream_id: 1, name: 'Family film', category_id: '5' },
            { stream_id: 2, name: 'Family after dark', category_id: '9' },
        ]);
        parentalLock.active.mockReturnValue(true);
        parentalLock.lockedXtreamIds.mockImplementation((_id, type) =>
            type === 'movies' ? [9] : []
        );

        const content = await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie'
        );
        const found = await dataSource.searchContent('playlist-1', 'family', [
            'movie',
        ]);

        expect(content.map((item) => item.name)).toEqual(['Family film']);
        expect(found.map((item) => item.name)).toEqual(['Family film']);

        parentalLock.active.mockReturnValue(false);
        const unlocked = await dataSource.searchContent(
            'playlist-1',
            'family',
            ['movie']
        );
        expect(unlocked).toHaveLength(2);
    });

    it('matches a noncanonical provider category id against its numeric lock', async () => {
        apiService.getStreams.mockResolvedValue([
            { stream_id: 1, name: 'Family film', category_id: '5' },
            { stream_id: 2, name: 'Family after dark', category_id: '009' },
        ]);
        parentalLock.active.mockReturnValue(true);
        parentalLock.lockedXtreamIds.mockImplementation((_id, type) =>
            type === 'movies' ? [9] : []
        );

        const content = await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie'
        );

        expect(content.map((item) => item.name)).toEqual(['Family film']);
    });

    it('withholds everything while the lock store cannot be read', async () => {
        apiService.getStreams.mockResolvedValue([
            { stream_id: 1, name: 'Family film', category_id: '5' },
        ]);
        parentalLock.active.mockReturnValue(true);
        parentalLock.withholdsEverything = jest.fn(() => true);

        const content = await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie'
        );
        const found = await dataSource.searchContent('playlist-1', 'family', [
            'movie',
        ]);

        expect(content).toEqual([]);
        expect(found).toEqual([]);
        expect(parentalLock.lockedXtreamIds).not.toHaveBeenCalled();
    });

    it('reports remote loading phases for API fetches but stays silent on cache hits', async () => {
        apiService.getStreams.mockResolvedValue([
            { stream_id: 1, name: 'News' },
        ]);
        const onPhaseChange = jest.fn();

        await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie',
            undefined,
            undefined,
            { onPhaseChange }
        );

        expect(onPhaseChange.mock.calls).toEqual([['loading-movies']]);

        onPhaseChange.mockClear();
        await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie',
            undefined,
            undefined,
            { onPhaseChange }
        );

        expect(onPhaseChange).not.toHaveBeenCalled();
        expect(apiService.getStreams).toHaveBeenCalledTimes(1);
    });

    it('does not treat unconfirmed empty entries as usable cache', async () => {
        const cacheState = dataSource as unknown as {
            categoryCache: Map<string, unknown[]>;
            contentCache: Map<string, unknown[]>;
        };
        cacheState.categoryCache.set('playlist-1-vod-categories', []);
        cacheState.contentCache.set('playlist-1-movie-content', []);

        await expect(
            dataSource.hasCategories('playlist-1', 'movies')
        ).resolves.toBe(false);
        await expect(
            dataSource.hasContent('playlist-1', 'movie')
        ).resolves.toBe(false);
    });

    it('reuses a successfully loaded empty catalog without treating it as offline content', async () => {
        apiService.getStreams.mockResolvedValue([]);

        await dataSource.getCategories('playlist-1', credentials, 'vod');
        await dataSource.getContent('playlist-1', credentials, 'movie');

        await expect(
            dataSource.hasCategories('playlist-1', 'movies')
        ).resolves.toBe(false);
        await expect(
            dataSource.hasContent('playlist-1', 'movie')
        ).resolves.toBe(false);

        await dataSource.getCategories('playlist-1', credentials, 'vod');
        await dataSource.getContent('playlist-1', credentials, 'movie');

        expect(apiService.getCategories).toHaveBeenCalledTimes(1);
        expect(apiService.getStreams).toHaveBeenCalledTimes(1);

        dataSource.clearSessionCache('playlist-1');

        await expect(
            dataSource.hasCategories('playlist-1', 'movies')
        ).resolves.toBe(false);
        await expect(
            dataSource.hasContent('playlist-1', 'movie')
        ).resolves.toBe(false);
    });

    it('hydrates the store from the actual non-empty PWA session cache while offline', async () => {
        apiService.getCategories.mockResolvedValue([
            {
                category_id: '7',
                category_name: 'Movies',
                parent_id: 0,
            },
        ]);
        apiService.getStreams.mockResolvedValue([
            {
                stream_id: 41,
                name: 'Cached movie',
                category_id: '7',
                stream_type: 'movie',
            },
        ]);
        await dataSource.getCategories('playlist-1', credentials, 'vod');
        await dataSource.getContent('playlist-1', credentials, 'movie');
        const store = TestBed.inject(PwaContentStore);
        store.setContentInitBlockReason('unavailable');

        await store.retryContentInitialization();

        expect(store.contentInitBlockReason()).toBeNull();
        expect(store.vodCategories()).toEqual([
            expect.objectContaining({ name: 'Movies', xtream_id: 7 }),
        ]);
        expect(store.vodStreams()).toEqual([
            expect.objectContaining({ name: 'Cached movie', xtream_id: 41 }),
        ]);
    });

    it('uses the same parental filtering for cache availability and hydration', async () => {
        apiService.getCategories.mockResolvedValue([
            {
                category_id: '7',
                category_name: 'Locked movies',
                parent_id: 0,
            },
        ]);
        apiService.getStreams.mockResolvedValue([
            {
                stream_id: 41,
                name: 'Locked movie',
                category_id: '7',
                stream_type: 'movie',
            },
        ]);
        await dataSource.getCategories('playlist-1', credentials, 'vod');
        await dataSource.getContent('playlist-1', credentials, 'movie');
        parentalLock.lockedXtreamIds.mockImplementation((_id, type) =>
            type === 'movies' ? [7] : []
        );

        await expect(
            dataSource.hasCategories('playlist-1', 'movies')
        ).resolves.toBe(true);
        await expect(
            dataSource.hasContent('playlist-1', 'movie')
        ).resolves.toBe(true);
        await expect(
            dataSource.getCachedCategories('playlist-1', 'vod')
        ).resolves.toHaveLength(1);
        await expect(
            dataSource.getCachedContent('playlist-1', 'movie')
        ).resolves.toHaveLength(1);

        parentalLock.active.mockReturnValue(true);

        await expect(
            dataSource.hasCategories('playlist-1', 'movies')
        ).resolves.toBe(false);
        await expect(
            dataSource.hasContent('playlist-1', 'movie')
        ).resolves.toBe(false);
        await expect(
            dataSource.getCachedCategories('playlist-1', 'vod')
        ).resolves.toEqual([]);
        await expect(
            dataSource.getCachedContent('playlist-1', 'movie')
        ).resolves.toEqual([]);
    });

    it('keeps Xtream passwords out of localStorage playlist metadata', async () => {
        await dataSource.createPlaylist({
            id: 'playlist-1',
            name: 'Xtream PWA',
            serverUrl: credentials.serverUrl,
            username: credentials.username,
            password: credentials.password,
            type: 'xtream',
        });

        const storedPlaylists = JSON.parse(
            localStorage.getItem('xtream-playlists') || '[]'
        );
        expect(storedPlaylists).toEqual([
            expect.not.objectContaining({
                password: credentials.password,
            }),
        ]);
        await expect(dataSource.getPlaylist('playlist-1')).resolves.toEqual(
            expect.objectContaining({
                password: credentials.password,
            })
        );
    });

    it('persists the panel timezone through one IndexedDB transform guarded by the request connection (issue #1562)', async () => {
        const credentials = {
            serverUrl: 'http://panel.example:8080',
            username: 'user',
            password: 'pass',
        };
        const row = {
            _id: 'playlist-1',
            title: 'Xtream',
            ...credentials,
        };
        await dataSource.createPlaylist({
            id: 'playlist-1',
            name: 'Xtream',
            type: 'xtream',
            ...credentials,
        });
        playlistsService.transformPlaylistMeta.mockImplementation(
            (_id: string, transform: (current: unknown) => unknown) =>
                of(transform(row))
        );

        await dataSource.rememberServerTimezone(
            'playlist-1',
            credentials,
            'UTC+03:00'
        );

        const [, transform] = playlistsService.transformPlaylistMeta.mock
            .calls[0] as [string, (current: unknown) => unknown];
        // The row still points at the panel → written, with the clock.
        expect(transform(row)).toEqual({ ...row, serverTimezone: 'UTC+03:00' });
        // Already carrying it, or moved to another panel → no write.
        expect(transform({ ...row, serverTimezone: 'UTC+03:00' })).toBeNull();
        expect(
            transform({ ...row, serverUrl: 'http://moved.example:8080' })
        ).toBeNull();
        // The localStorage copy follows the successful write.
        await expect(dataSource.getPlaylist('playlist-1')).resolves.toEqual(
            expect.objectContaining({ serverTimezone: 'UTC+03:00' })
        );
    });

    it('carries the persisted panel timezone from the IndexedDB row into the store playlist (issue #1562)', async () => {
        playlistsService.getPlaylistById.mockReturnValue(
            of({
                _id: 'playlist-1',
                title: 'Xtream',
                importDate: '2026-04-01T00:00:00.000Z',
                lastUsage: '2026-04-01T00:00:00.000Z',
                count: 0,
                autoRefresh: false,
                serverUrl: 'http://panel.example:8080',
                username: 'user',
                password: 'pass',
                serverTimezone: 'UTC+03:00',
            })
        );

        await expect(dataSource.getPlaylist('playlist-1')).resolves.toEqual(
            expect.objectContaining({
                id: 'playlist-1',
                serverTimezone: 'UTC+03:00',
            })
        );
    });

    it('uses current playlist metadata before stale PWA storage when fetching playlist details', async () => {
        await dataSource.createPlaylist({
            id: 'playlist-1',
            name: 'Old Xtream',
            title: 'Old Xtream',
            serverUrl: 'http://old.example:8080',
            username: 'old-user',
            password: 'old-pass',
            type: 'xtream',
        });
        playlistsService.getPlaylistById.mockReturnValue(
            of({
                _id: 'playlist-1',
                title: 'Updated Xtream',
                importDate: '2026-04-01T00:00:00.000Z',
                lastUsage: '2026-04-01T00:00:00.000Z',
                count: 0,
                autoRefresh: false,
                updateDate: 123,
                serverUrl: 'http://new.example:8080',
                username: 'new-user',
                password: 'new-pass',
                userAgent: 'new-agent',
                referrer: 'https://referrer.example',
                origin: 'https://origin.example',
            })
        );

        await expect(dataSource.getPlaylist('playlist-1')).resolves.toEqual(
            expect.objectContaining({
                id: 'playlist-1',
                name: 'Updated Xtream',
                title: 'Updated Xtream',
                updateDate: 123,
                serverUrl: 'http://new.example:8080',
                username: 'new-user',
                password: 'new-pass',
                userAgent: 'new-agent',
                referrer: 'https://referrer.example',
                origin: 'https://origin.example',
            })
        );
        expect(
            JSON.parse(localStorage.getItem('xtream-playlists') || '[]')
        ).toEqual([
            expect.objectContaining({
                id: 'playlist-1',
                name: 'Updated Xtream',
                title: 'Updated Xtream',
                serverUrl: 'http://new.example:8080',
                username: 'new-user',
                type: 'xtream',
            }),
        ]);
    });

    it('normalizes Xtream API stream identifiers for PWA catalog navigation', async () => {
        apiService.getStreams.mockImplementation(
            (_credentials: XtreamCredentials, type: string) => {
                switch (type) {
                    case 'live':
                        return Promise.resolve([
                            {
                                id: '0',
                                stream_id: 101,
                                name: 'News Live',
                                stream_icon: 'live.png',
                                category_id: '10',
                                added: '1',
                            },
                        ]);
                    case 'movie':
                        return Promise.resolve([
                            {
                                id: 0,
                                stream_id: 202,
                                name: 'Movie One',
                                stream_icon: 'movie.png',
                                category_id: '20',
                                added: '2',
                            },
                        ]);
                    case 'series':
                        return Promise.resolve([
                            {
                                series_id: 303,
                                name: 'Series One',
                                cover: 'series.png',
                                category_id: 30,
                                last_modified: '3',
                            },
                        ]);
                    default:
                        return Promise.resolve([]);
                }
            }
        );

        const live = (await dataSource.getContent(
            'playlist-1',
            credentials,
            'live'
        )) as XtreamContentItem[];
        const vod = (await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie'
        )) as XtreamContentItem[];
        const series = (await dataSource.getContent(
            'playlist-1',
            credentials,
            'series'
        )) as XtreamContentItem[];

        expect(live[0]).toEqual(
            expect.objectContaining({
                id: 101,
                stream_id: 101,
                title: 'News Live',
                poster_url: 'live.png',
                type: 'live',
                xtream_id: 101,
            })
        );
        expect(vod[0]).toEqual(
            expect.objectContaining({
                id: 202,
                stream_id: 202,
                title: 'Movie One',
                poster_url: 'movie.png',
                type: 'movie',
                xtream_id: 202,
            })
        );
        expect(series[0]).toEqual(
            expect.objectContaining({
                id: 303,
                series_id: 303,
                title: 'Series One',
                poster_url: 'series.png',
                type: 'series',
                xtream_id: 303,
            })
        );

        await expect(
            dataSource.getContentByXtreamId(202, 'playlist-1', 'movie')
        ).resolves.toEqual(
            expect.objectContaining({
                title: 'Movie One',
                type: 'movie',
                xtream_id: 202,
            })
        );
    });

    it('keeps homonymous provider variants by remote id and exposes their metadata labels', async () => {
        apiService.getCategories.mockResolvedValue([
            {
                category_id: '20',
                category_name: 'Movies',
                parent_id: 0,
                count: 2,
            },
        ]);
        apiService.getStreams.mockResolvedValue([
            {
                stream_id: 201,
                name: 'The Example',
                category_id: '20',
                audio_language: 'es',
                quality: '4K',
                container_extension: 'mkv',
            },
            {
                stream_id: 202,
                name: 'The Example',
                category_id: '20',
                audio_language: 'en',
                quality: 'HD',
                container_extension: 'mp4',
            },
        ]);

        const content = (await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie'
        )) as XtreamContentItem[];

        expect(content.map((item) => item.xtream_id)).toEqual([201, 202]);
        expect(content.map((item) => item.title)).toEqual([
            'The Example',
            'The Example',
        ]);
        expect(content.map((item) => item.variant_label)).toEqual([
            'ES · 4K · MKV',
            'EN · HD · MP4',
        ]);
    });

    it('recovers omitted and truncated catalog rows from category endpoints', async () => {
        apiService.getCategories.mockResolvedValue([
            {
                category_id: '10',
                category_name: 'One',
                parent_id: 0,
                count: 2,
            },
            {
                category_id: '20',
                category_name: 'Two',
                parent_id: 0,
                // Some panels expose stale zero counts even when the scoped
                // endpoint still has content; absence from the global list
                // must therefore trigger verification on its own.
                count: 0,
            },
        ]);
        apiService.getStreams.mockImplementation(
            (_credentials, _type, options?: { categoryId?: string }) => {
                if (options?.categoryId === '10') {
                    return Promise.resolve([
                        {
                            stream_id: 101,
                            name: 'Shared name',
                            category_id: '10',
                        },
                        {
                            stream_id: 102,
                            name: 'Shared name',
                            category_id: '10',
                        },
                    ]);
                }
                if (options?.categoryId === '20') {
                    return Promise.resolve([
                        {
                            stream_id: 201,
                            name: 'Shared name',
                            category_id: '20',
                        },
                    ]);
                }
                return Promise.resolve([
                    {
                        stream_id: 101,
                        name: 'Shared name',
                        category_id: '10',
                    },
                ]);
            }
        );

        const content = (await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie'
        )) as XtreamContentItem[];

        expect(content.map((item) => item.xtream_id)).toEqual([101, 102, 201]);
        expect(dataSource.getCatalogDiagnostics('playlist-1', 'movie')).toEqual(
            {
                totalCount: 3,
                globalCount: 1,
                recoveredCount: 2,
                invalidItemCount: 0,
                failedCategoryCount: 0,
                recoveredCategoryCount: 2,
                status: 'recovered',
            }
        );
    });

    it('keeps the usable global catalog and reports failed category recovery', async () => {
        apiService.getCategories.mockResolvedValue([
            {
                category_id: '10',
                category_name: 'Movies',
                parent_id: 0,
                count: 2,
            },
        ]);
        apiService.getStreams.mockImplementation(
            (_credentials, _type, options?: { categoryId?: string }) =>
                options?.categoryId
                    ? Promise.reject(new Error('category unavailable'))
                    : Promise.resolve([
                          {
                              stream_id: 101,
                              name: 'Available movie',
                              category_id: '10',
                          },
                      ])
        );

        const content = (await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie'
        )) as XtreamContentItem[];

        expect(content).toEqual([expect.objectContaining({ xtream_id: 101 })]);
        expect(dataSource.getCatalogDiagnostics('playlist-1', 'movie')).toEqual(
            expect.objectContaining({
                failedCategoryCount: 1,
                status: 'partial',
                totalCount: 1,
            })
        );
    });

    it('matches legacy string favorite and recent ids against numeric content identities', async () => {
        apiService.getStreams.mockResolvedValue([
            {
                stream_id: 202,
                name: 'Movie One',
                stream_icon: 'movie.png',
                category_id: '20',
                added: '2',
            },
        ]);
        localStorage.setItem(
            'xtream-favorites',
            JSON.stringify({ 'playlist-1': ['202'] })
        );
        localStorage.setItem(
            'xtream-recent-items',
            JSON.stringify({
                'playlist-1': [
                    {
                        id: '202',
                        viewedAt: '2026-05-21T12:00:00.000Z',
                    },
                ],
            })
        );

        await dataSource.getContent('playlist-1', credentials, 'movie');
        apiService.getStreams.mockResolvedValue([]);
        await dataSource.getContent('playlist-1', credentials, 'live');
        await dataSource.getContent('playlist-1', credentials, 'series');

        await expect(dataSource.isFavorite(202, 'playlist-1')).resolves.toBe(
            true
        );
        await expect(dataSource.getFavorites('playlist-1')).resolves.toEqual([
            expect.objectContaining({
                title: 'Movie One',
                xtream_id: 202,
            }),
        ]);
        await expect(dataSource.getRecentItems('playlist-1')).resolves.toEqual([
            expect.objectContaining({
                title: 'Movie One',
                viewed_at: '2026-05-21T12:00:00.000Z',
                xtream_id: 202,
            }),
        ]);
    });

    it('does not persist zero or invalid Xtream identities as user collections', async () => {
        apiService.getStreams.mockResolvedValue([
            {
                id: 0,
                name: 'Headless Zero',
                category_id: '20',
            },
            {
                id: 'not-a-number',
                name: 'Headless Invalid',
                category_id: '20',
            },
        ]);

        const content = (await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie'
        )) as XtreamContentItem[];

        expect(content).toEqual([]);
        expect(dataSource.getCatalogDiagnostics('playlist-1', 'movie')).toEqual(
            expect.objectContaining({
                invalidItemCount: 2,
                status: 'partial',
                totalCount: 0,
            })
        );

        await dataSource.addFavorite(-1, 'playlist-1');
        await dataSource.addRecentItem(-1, 'playlist-1');

        expect(localStorage.getItem('xtream-favorites')).toBeNull();
        expect(localStorage.getItem('xtream-recent-items')).toBeNull();

        localStorage.setItem(
            'xtream-favorites',
            JSON.stringify({ 'playlist-1': [-1, 0, 'not-a-number'] })
        );
        localStorage.setItem(
            'xtream-recent-items',
            JSON.stringify({
                'playlist-1': [
                    {
                        id: -1,
                        viewedAt: '2026-05-21T12:00:00.000Z',
                    },
                    {
                        id: 0,
                        viewedAt: '2026-05-21T12:00:00.000Z',
                    },
                    {
                        id: 'not-a-number',
                        viewedAt: '2026-05-21T12:00:00.000Z',
                    },
                ],
            })
        );

        await expect(dataSource.getFavorites('playlist-1')).resolves.toEqual(
            []
        );
        await expect(dataSource.getRecentItems('playlist-1')).resolves.toEqual(
            []
        );
    });

    it('hydrates stored favorites and recent items from the API when content cache is cold', async () => {
        await dataSource.createPlaylist({
            id: 'playlist-1',
            name: 'Xtream PWA',
            serverUrl: credentials.serverUrl,
            username: credentials.username,
            password: credentials.password,
            type: 'xtream',
        });
        apiService.getStreams.mockImplementation(
            (_credentials: XtreamCredentials, type: string) =>
                Promise.resolve(
                    type === 'movie'
                        ? [
                              {
                                  stream_id: 202,
                                  name: 'Movie One',
                                  stream_icon: 'movie.png',
                                  category_id: '20',
                              },
                          ]
                        : []
                )
        );
        localStorage.setItem(
            'xtream-favorites',
            JSON.stringify({ 'playlist-1': [202] })
        );
        localStorage.setItem(
            'xtream-recent-items',
            JSON.stringify({
                'playlist-1': [
                    {
                        id: 202,
                        viewedAt: '2026-05-21T12:00:00.000Z',
                    },
                ],
            })
        );

        await expect(dataSource.getFavorites('playlist-1')).resolves.toEqual([
            expect.objectContaining({
                title: 'Movie One',
                xtream_id: 202,
            }),
        ]);
        await expect(dataSource.getRecentItems('playlist-1')).resolves.toEqual([
            expect.objectContaining({
                title: 'Movie One',
                viewed_at: '2026-05-21T12:00:00.000Z',
                xtream_id: 202,
            }),
        ]);
        expect(apiService.getStreams).toHaveBeenCalledWith(
            credentials,
            'movie'
        );
    });

    it('uses the Xtream stream ID as the PWA content ID when raw id differs', async () => {
        apiService.getStreams.mockResolvedValue([
            {
                id: 5,
                stream_id: 202,
                name: 'Movie One',
                stream_icon: 'movie.png',
                category_id: '20',
            },
        ]);

        const content = (await dataSource.getContent(
            'playlist-1',
            credentials,
            'movie'
        )) as XtreamContentItem[];

        expect(content[0]).toEqual(
            expect.objectContaining({
                id: 202,
                xtream_id: 202,
            })
        );

        await dataSource.addFavorite(
            { id: Number(content[0].id), type: 'movie' },
            'playlist-1'
        );
        await dataSource.addRecentItem(
            { id: Number(content[0].id), type: 'movie' },
            'playlist-1'
        );

        await expect(dataSource.getFavorites('playlist-1')).resolves.toEqual([
            expect.objectContaining({
                id: 202,
                title: 'Movie One',
                xtream_id: 202,
            }),
        ]);
        await expect(dataSource.getRecentItems('playlist-1')).resolves.toEqual([
            expect.objectContaining({
                id: 202,
                title: 'Movie One',
                xtream_id: 202,
            }),
        ]);
    });

    it('backfills PWA recent-item backdrop metadata without rewriting recency', async () => {
        apiService.getStreams.mockResolvedValue([
            {
                stream_id: 202,
                name: 'Movie One',
                stream_icon: 'movie.png',
                category_id: '20',
            },
        ]);

        await dataSource.getContent('playlist-1', credentials, 'movie');
        await dataSource.addRecentItem(
            { id: 202, type: 'movie' },
            'playlist-1'
        );
        const before = JSON.parse(
            localStorage.getItem('xtream-recent-items') || '{}'
        )['playlist-1'][0].viewedAt;

        await dataSource.setContentMetadataIfMissing(
            { id: 202, type: 'movie' },
            'playlist-1',
            {
                backdropUrl: ' https://example.com/backdrop.png ',
            }
        );

        const stored = JSON.parse(
            localStorage.getItem('xtream-recent-items') || '{}'
        )['playlist-1'][0];
        const storedSnapshot = JSON.parse(
            localStorage.getItem('xtream-collection-items') || '{}'
        )['playlist-1']['movie:202'];
        expect(stored).toEqual(
            expect.objectContaining({
                id: 'movie:202',
                backdropUrl: 'https://example.com/backdrop.png',
                viewedAt: before,
            })
        );
        expect(storedSnapshot).toEqual(
            expect.objectContaining({
                backdrop_url: 'https://example.com/backdrop.png',
                title: 'Movie One',
                xtream_id: 202,
            })
        );
        await expect(dataSource.getRecentItems('playlist-1')).resolves.toEqual([
            expect.objectContaining({
                backdrop_url: 'https://example.com/backdrop.png',
                title: 'Movie One',
                xtream_id: 202,
            }),
        ]);
    });

    it('uses stored collection snapshots for fresh-session favorites and recent items', async () => {
        await dataSource.createPlaylist({
            id: 'playlist-1',
            name: 'Xtream PWA',
            serverUrl: credentials.serverUrl,
            username: credentials.username,
            password: credentials.password,
            type: 'xtream',
        });
        apiService.getStreams.mockResolvedValue([
            {
                stream_id: 202,
                name: 'Movie One',
                stream_icon: 'movie.png',
                category_id: '20',
            },
        ]);

        await dataSource.getContent('playlist-1', credentials, 'movie');
        await dataSource.addFavorite({ id: 202, type: 'movie' }, 'playlist-1');
        await dataSource.addRecentItem(
            { id: 202, type: 'movie' },
            'playlist-1',
            'https://example.com/backdrop.png'
        );

        const storedCollectionItems = JSON.parse(
            localStorage.getItem('xtream-collection-items') || '{}'
        );
        expect(storedCollectionItems['playlist-1']['movie:202']).toEqual(
            expect.objectContaining({
                title: 'Movie One',
                xtream_id: 202,
            })
        );

        TestBed.resetTestingModule();
        apiService = {
            getCategories: jest.fn().mockResolvedValue([]),
            getStreams: jest.fn(),
        };
        TestBed.configureTestingModule({
            providers: [
                PwaXtreamDataSource,
                {
                    provide: XtreamApiService,
                    useValue: apiService,
                },
                {
                    provide: PlaylistsService,
                    useValue: playlistsService,
                },
            ],
        });
        dataSource = TestBed.inject(PwaXtreamDataSource);

        await expect(dataSource.getFavorites('playlist-1')).resolves.toEqual([
            expect.objectContaining({
                title: 'Movie One',
                xtream_id: 202,
            }),
        ]);
        await expect(dataSource.getRecentItems('playlist-1')).resolves.toEqual([
            expect.objectContaining({
                backdrop_url: 'https://example.com/backdrop.png',
                title: 'Movie One',
                xtream_id: 202,
            }),
        ]);
        expect(apiService.getStreams).not.toHaveBeenCalled();
    });

    describe('playback position batches', () => {
        const storageKey = 'xtream-playback-positions';

        const position = (
            overrides: Partial<PlaybackPositionData> = {}
        ): PlaybackPositionData => ({
            contentXtreamId: 100,
            contentType: 'vod',
            positionSeconds: 42,
            durationSeconds: 5400,
            playlistId: 'playlist-1',
            ...overrides,
        });

        it('writes a playback-position batch save as one storage write with upsert semantics', async () => {
            localStorage.setItem(
                storageKey,
                JSON.stringify({
                    'playlist-1': [
                        position({
                            contentXtreamId: 100,
                            contentType: 'episode',
                            positionSeconds: 10,
                            updatedAt: '2026-01-01T00:00:00.000Z',
                        }),
                    ],
                    'playlist-2': [
                        position({
                            playlistId: 'playlist-2',
                            contentXtreamId: 900,
                            updatedAt: '2026-01-01T00:00:00.000Z',
                        }),
                    ],
                })
            );
            const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

            await dataSource.savePlaybackPositionsBatch('playlist-1', [
                position({
                    contentXtreamId: 100,
                    contentType: 'episode',
                    positionSeconds: 1200,
                }),
                position({
                    contentXtreamId: 101,
                    contentType: 'episode',
                    positionSeconds: 1300,
                }),
            ]);

            expect(setItemSpy).toHaveBeenCalledTimes(1);
            setItemSpy.mockRestore();

            const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
            const playlistRows = stored['playlist-1'] as PlaybackPositionData[];
            expect(playlistRows).toHaveLength(2);

            const replaced = playlistRows.find(
                (row) => row.contentXtreamId === 100
            );
            const appended = playlistRows.find(
                (row) => row.contentXtreamId === 101
            );
            expect(replaced).toEqual(
                expect.objectContaining({
                    contentType: 'episode',
                    positionSeconds: 1200,
                })
            );
            expect(replaced?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
            // The whole batch is stamped with one shared timestamp.
            expect(appended?.updatedAt).toBe(replaced?.updatedAt);
            expect(stored['playlist-2']).toEqual([
                expect.objectContaining({
                    contentXtreamId: 900,
                    updatedAt: '2026-01-01T00:00:00.000Z',
                }),
            ]);
        });

        it('removes only the named rows in a single write on batch clear', async () => {
            localStorage.setItem(
                storageKey,
                JSON.stringify({
                    'playlist-1': [
                        position({
                            contentXtreamId: 100,
                            contentType: 'episode',
                        }),
                        position({
                            contentXtreamId: 101,
                            contentType: 'episode',
                        }),
                        position({ contentXtreamId: 202 }),
                    ],
                    'playlist-2': [
                        position({
                            playlistId: 'playlist-2',
                            contentXtreamId: 100,
                            contentType: 'episode',
                        }),
                    ],
                })
            );
            const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

            await dataSource.clearPlaybackPositionsBatch('playlist-1', [
                { contentXtreamId: 100, contentType: 'episode' },
                { contentXtreamId: 101, contentType: 'episode' },
            ]);

            expect(setItemSpy).toHaveBeenCalledTimes(1);
            setItemSpy.mockRestore();

            const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
            expect(stored['playlist-1']).toEqual([
                expect.objectContaining({
                    contentXtreamId: 202,
                    contentType: 'vod',
                }),
            ]);
            // Another playlist's row with the same episode key survives.
            expect(stored['playlist-2']).toEqual([
                expect.objectContaining({
                    contentXtreamId: 100,
                    contentType: 'episode',
                }),
            ]);
        });

        it('skips storage writes for empty batches and missing playlist buckets', async () => {
            const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

            await dataSource.savePlaybackPositionsBatch('playlist-1', []);
            await dataSource.clearPlaybackPositionsBatch('playlist-1', []);
            await dataSource.clearPlaybackPositionsBatch('playlist-1', [
                { contentXtreamId: 100, contentType: 'vod' },
            ]);

            expect(setItemSpy).not.toHaveBeenCalled();
            setItemSpy.mockRestore();
        });
    });

    describe('with an injected user data storage', () => {
        it('reads and writes favorites through it, not localStorage', async () => {
            const values = new Map<string, string>();
            const storage = {
                getItem: (key: string) => values.get(key) ?? null,
                setItem: (key: string, value: string) => {
                    values.set(key, value);
                },
                removeItem: (key: string) => {
                    values.delete(key);
                },
            };
            TestBed.resetTestingModule();
            TestBed.configureTestingModule({
                providers: [
                    PwaXtreamDataSource,
                    { provide: USER_DATA_STORAGE, useValue: storage },
                    { provide: ParentalLockService, useValue: parentalLock },
                    { provide: XtreamApiService, useValue: apiService },
                    { provide: PlaylistsService, useValue: playlistsService },
                ],
            });
            const source = TestBed.inject(PwaXtreamDataSource);

            values.set('xtream-favorites', JSON.stringify({ p1: ['live:1'] }));
            await source.deletePlaylist('p1');

            expect(JSON.parse(values.get('xtream-favorites') ?? '{}')).toEqual(
                {}
            );
            expect(localStorage.getItem('xtream-favorites')).toBeNull();
        });
    });
});
