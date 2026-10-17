import { TestBed } from '@angular/core/testing';
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
import { Playlist, PlaylistMeta } from '@iptvnator/shared/interfaces';
import { of } from 'rxjs';
import { GlobalSearchService } from './global-search.service';

const xtreamPlaylist = {
    _id: 'xtream-1',
    title: 'Primary portal',
    serverUrl: 'https://provider.test',
    username: 'user',
    password: 'pass',
} as PlaylistMeta;

const m3uPlaylist = {
    _id: 'm3u-1',
    title: 'Local channels',
} as PlaylistMeta;

const stalkerPlaylist = {
    _id: 'stalker-1',
    title: 'Stalker portal',
    macAddress: '00:11:22:33:44:55',
    portalUrl: 'https://stalker.test/portal.php',
} as PlaylistMeta;

function xtreamItem(
    overrides: Partial<XtreamContentItem> = {}
): XtreamContentItem {
    return {
        id: 42,
        category_id: '7',
        title: 'The Matrix',
        rating: '8.7',
        added: '100',
        poster_url: 'https://images.test/matrix.jpg',
        xtream_id: 42,
        type: 'movie',
        ...overrides,
    };
}

describe('GlobalSearchService', () => {
    let runtime: { isElectron: boolean };
    let database: { globalSearchContent: jest.Mock };
    let playlists: {
        getAllPlaylists: jest.Mock;
        getPlaylist: jest.Mock;
    };
    let dataSource: {
        getPlaylist: jest.Mock;
        getContent: jest.Mock;
        searchContent: jest.Mock;
    };
    let parentalLockVersion: number;
    let parentalLock: {
        active: jest.Mock;
        withholdsEverything: jest.Mock;
        version: jest.Mock;
        isM3uGroupLocked: jest.Mock;
        isXtreamCategoryLocked: jest.Mock;
    };

    beforeEach(() => {
        runtime = { isElectron: false };
        database = { globalSearchContent: jest.fn().mockResolvedValue([]) };
        playlists = {
            getAllPlaylists: jest.fn(() => of([])),
            getPlaylist: jest.fn(() => of(undefined)),
        };
        dataSource = {
            getPlaylist: jest.fn().mockResolvedValue({
                id: xtreamPlaylist._id,
                name: xtreamPlaylist.title,
                serverUrl: xtreamPlaylist.serverUrl,
                username: xtreamPlaylist.username,
                password: xtreamPlaylist.password,
                type: 'xtream',
            }),
            getContent: jest.fn().mockResolvedValue([]),
            searchContent: jest.fn().mockResolvedValue([]),
        };
        parentalLockVersion = 0;
        parentalLock = {
            active: jest.fn(() => false),
            withholdsEverything: jest.fn(() => false),
            version: jest.fn(() => parentalLockVersion),
            isM3uGroupLocked: jest.fn(() => false),
            isXtreamCategoryLocked: jest.fn(() => false),
        };

        TestBed.configureTestingModule({
            providers: [
                GlobalSearchService,
                {
                    provide: RuntimeCapabilitiesService,
                    useValue: runtime,
                },
                { provide: DatabaseService, useValue: database },
                { provide: PlaylistsService, useValue: playlists },
                { provide: ParentalLockService, useValue: parentalLock },
                {
                    provide: XTREAM_DATA_SOURCE,
                    useValue: dataSource as Partial<IXtreamDataSource>,
                },
            ],
        });
    });

    it('keeps Electron on the worker-backed global search path', async () => {
        runtime.isElectron = true;
        const expected = [xtreamItem()];
        database.globalSearchContent.mockResolvedValue(expected);

        expect(
            TestBed.inject(GlobalSearchService).supportsHiddenCategoryFilter
        ).toBe(true);

        await expect(
            TestBed.inject(GlobalSearchService).globalSearchContent(
                'matrix',
                ['movie'],
                true,
                { limit: 11, offset: 20 }
            )
        ).resolves.toBe(expected);

        expect(database.globalSearchContent).toHaveBeenCalledWith(
            'matrix',
            ['movie'],
            true,
            undefined,
            { limit: 11, offset: 20 }
        );
        expect(playlists.getAllPlaylists).not.toHaveBeenCalled();
    });

    it('loads and searches only the selected Xtream scope in the PWA', async () => {
        expect(
            TestBed.inject(GlobalSearchService).supportsHiddenCategoryFilter
        ).toBe(false);
        playlists.getAllPlaylists.mockReturnValue(of([xtreamPlaylist]));
        dataSource.searchContent.mockResolvedValue([
            xtreamItem({
                id: 91,
                title: 'Matrix: The Series',
                type: 'series',
                xtream_id: 91,
            }),
        ]);

        const results = await TestBed.inject(
            GlobalSearchService
        ).globalSearchContent('matrix', ['series'], false, {
            limit: 101,
            offset: 0,
        });

        expect(dataSource.getContent).toHaveBeenCalledTimes(1);
        expect(dataSource.getContent).toHaveBeenCalledWith(
            'xtream-1',
            {
                serverUrl: 'https://provider.test',
                username: 'user',
                password: 'pass',
            },
            'series',
            undefined,
            undefined
        );
        expect(dataSource.searchContent).toHaveBeenCalledWith(
            'xtream-1',
            'matrix',
            ['series'],
            false
        );
        expect(results).toEqual([
            expect.objectContaining({
                id: 'xtream-1:series:91',
                source_type: 'xtream',
                content_type: 'series',
                playlist_id: 'xtream-1',
                playlist_name: 'Primary portal',
                title: 'Matrix: The Series',
            }),
        ]);
        expect(database.globalSearchContent).not.toHaveBeenCalled();
    });

    it('keeps healthy Xtream content types when one provider endpoint fails', async () => {
        playlists.getAllPlaylists.mockReturnValue(of([xtreamPlaylist]));
        dataSource.getContent.mockImplementation(
            (_playlistId: string, _credentials: unknown, type: string) =>
                type === 'movie'
                    ? Promise.reject(new Error('movie endpoint unavailable'))
                    : Promise.resolve([])
        );
        dataSource.searchContent.mockResolvedValue([
            xtreamItem({ title: 'Matrix Live', type: 'live' }),
        ]);

        const results = await TestBed.inject(
            GlobalSearchService
        ).globalSearchContent('matrix', ['live', 'movie']);

        expect(dataSource.searchContent).toHaveBeenCalledWith(
            'xtream-1',
            'matrix',
            ['live'],
            false
        );
        expect(results).toEqual([
            expect.objectContaining({ title: 'Matrix Live', type: 'live' }),
        ]);
    });

    it('shares in-flight catalog loads and reloads them after completion', async () => {
        playlists.getAllPlaylists.mockReturnValue(of([xtreamPlaylist]));
        let finishCatalogLoad!: () => void;
        const catalogLoad = new Promise<void>((resolve) => {
            finishCatalogLoad = resolve;
        });
        dataSource.getContent.mockReturnValue(catalogLoad);
        const service = TestBed.inject(GlobalSearchService);

        const firstSearch = service.globalSearchContent('matrix', [
            'live',
            'movie',
        ]);
        const secondSearch = service.globalSearchContent('matrix', [
            'live',
            'movie',
        ]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(dataSource.getContent).toHaveBeenCalledTimes(2);
        finishCatalogLoad();
        await Promise.all([firstSearch, secondSearch]);

        await service.globalSearchContent('matrix', ['live', 'movie']);
        expect(dataSource.getContent).toHaveBeenCalledTimes(4);
    });

    it('rejects when the only searchable source fails and retries later', async () => {
        playlists.getAllPlaylists.mockReturnValue(of([xtreamPlaylist]));
        dataSource.getContent
            .mockRejectedValueOnce(new Error('catalog unavailable'))
            .mockResolvedValueOnce([]);
        const service = TestBed.inject(GlobalSearchService);

        await expect(
            service.globalSearchContent('matrix', ['movie'])
        ).rejects.toThrow('catalog unavailable');
        await expect(
            service.globalSearchContent('matrix', ['movie'])
        ).resolves.toEqual([]);

        expect(dataSource.getContent).toHaveBeenCalledTimes(2);
        expect(dataSource.searchContent).toHaveBeenCalledTimes(1);
    });

    it('adds visible M3U channels to TV searches and ignores Stalker sources', async () => {
        playlists.getAllPlaylists.mockReturnValue(
            of([m3uPlaylist, stalkerPlaylist])
        );
        playlists.getPlaylist.mockReturnValue(
            of({
                ...m3uPlaylist,
                hiddenGroupTitles: ['Adult'],
                playlist: {
                    items: [
                        {
                            id: 'news',
                            name: 'Daily News',
                            url: 'https://stream.test/news.m3u8',
                            group: { title: 'News' },
                            tvg: { logo: 'https://images.test/news.png' },
                        },
                        {
                            id: 'hidden-news',
                            name: 'News After Dark',
                            url: 'https://stream.test/hidden.m3u8',
                            group: { title: 'Adult' },
                            tvg: {},
                        },
                    ],
                },
            } as Playlist)
        );

        const results = await TestBed.inject(
            GlobalSearchService
        ).globalSearchContent('news', ['live'], true);

        expect(results).toEqual([
            expect.objectContaining({
                source_type: 'm3u',
                content_type: 'live',
                playlist_id: 'm3u-1',
                channel_id: 'news',
                title: 'Daily News',
            }),
        ]);
        expect(playlists.getPlaylist).toHaveBeenCalledTimes(1);
        expect(dataSource.getPlaylist).not.toHaveBeenCalled();
    });

    it('never exposes M3U groups withheld by the parental lock', async () => {
        playlists.getAllPlaylists.mockReturnValue(of([m3uPlaylist]));
        playlists.getPlaylist.mockReturnValue(
            of({
                ...m3uPlaylist,
                playlist: {
                    items: [
                        {
                            id: 'news',
                            name: 'Daily News',
                            url: 'https://stream.test/news.m3u8',
                            group: { title: 'News' },
                            tvg: {},
                        },
                        {
                            id: 'adult',
                            name: 'News After Dark',
                            url: 'https://stream.test/adult.m3u8',
                            group: { title: 'Adult' },
                            tvg: {},
                        },
                    ],
                },
            } as Playlist)
        );
        parentalLock.isM3uGroupLocked.mockImplementation(
            (_playlistId: string, groupTitle: string) => groupTitle === 'Adult'
        );

        const results = await TestBed.inject(
            GlobalSearchService
        ).globalSearchContent('news', ['live'], false);

        expect(results.map((item) => item.title)).toEqual(['Daily News']);
        expect(parentalLock.isM3uGroupLocked).toHaveBeenCalledWith(
            'm3u-1',
            'Adult'
        );
    });

    it('fails closed when the parental lock withholds every M3U group', async () => {
        playlists.getAllPlaylists.mockReturnValue(of([m3uPlaylist]));
        playlists.getPlaylist.mockReturnValue(
            of({
                ...m3uPlaylist,
                playlist: {
                    items: [
                        {
                            id: 'news',
                            name: 'Daily News',
                            url: 'https://stream.test/news.m3u8',
                            group: { title: 'News' },
                            tvg: {},
                        },
                    ],
                },
            } as Playlist)
        );
        parentalLock.isM3uGroupLocked.mockReturnValue(true);

        await expect(
            TestBed.inject(GlobalSearchService).globalSearchContent(
                'news',
                ['live'],
                false
            )
        ).resolves.toEqual([]);
    });

    it('keeps results from healthy PWA sources when another source fails', async () => {
        const secondXtream = {
            ...xtreamPlaylist,
            _id: 'xtream-2',
            title: 'Backup portal',
        } as PlaylistMeta;
        playlists.getAllPlaylists.mockReturnValue(
            of([xtreamPlaylist, secondXtream])
        );
        dataSource.getPlaylist.mockImplementation((playlistId: string) =>
            playlistId === 'xtream-1'
                ? Promise.reject(new Error('unavailable'))
                : Promise.resolve({
                      id: secondXtream._id,
                      name: secondXtream.title,
                      serverUrl: secondXtream.serverUrl,
                      username: secondXtream.username,
                      password: secondXtream.password,
                      type: 'xtream',
                  })
        );
        dataSource.searchContent.mockResolvedValue([
            xtreamItem({ title: 'Backup News', type: 'live' }),
        ]);

        const results = await TestBed.inject(
            GlobalSearchService
        ).globalSearchContent('news', ['live']);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual(
            expect.objectContaining({
                playlist_id: 'xtream-2',
                title: 'Backup News',
            })
        );
    });

    it('keeps a stable result snapshot across pages after a source fails', async () => {
        const secondXtream = {
            ...xtreamPlaylist,
            _id: 'xtream-2',
            title: 'Backup portal',
        } as PlaylistMeta;
        playlists.getAllPlaylists.mockReturnValue(
            of([xtreamPlaylist, secondXtream])
        );
        let primaryAttempts = 0;
        dataSource.getPlaylist.mockImplementation((playlistId: string) => {
            if (playlistId === xtreamPlaylist._id && ++primaryAttempts === 1) {
                return Promise.reject(new Error('temporarily unavailable'));
            }
            const playlist =
                playlistId === xtreamPlaylist._id
                    ? xtreamPlaylist
                    : secondXtream;
            return Promise.resolve({
                id: playlist._id,
                name: playlist.title,
                serverUrl: playlist.serverUrl,
                username: playlist.username,
                password: playlist.password,
                type: 'xtream',
            });
        });
        dataSource.searchContent.mockImplementation((playlistId: string) =>
            Promise.resolve(
                playlistId === xtreamPlaylist._id
                    ? [xtreamItem({ title: 'Matrix Alpha', xtream_id: 1 })]
                    : [
                          xtreamItem({ title: 'Matrix Beta', xtream_id: 2 }),
                          xtreamItem({ title: 'Matrix Gamma', xtream_id: 3 }),
                          xtreamItem({ title: 'Matrix Omega', xtream_id: 4 }),
                      ]
            )
        );
        const service = TestBed.inject(GlobalSearchService);

        const firstPage = await service.globalSearchContent(
            'matrix',
            ['movie'],
            false,
            { limit: 2, offset: 0 }
        );
        const secondPage = await service.globalSearchContent(
            'matrix',
            ['movie'],
            false,
            { limit: 2, offset: 2 }
        );

        expect([
            ...firstPage.map((item) => item.title),
            ...secondPage.map((item) => item.title),
        ]).toEqual(['Matrix Beta', 'Matrix Gamma', 'Matrix Omega']);
        expect(primaryAttempts).toBe(1);

        const freshSearch = await service.globalSearchContent(
            'matrix',
            ['movie'],
            false,
            { limit: 2, offset: 0 }
        );

        expect(freshSearch.map((item) => item.title)).toEqual([
            'Matrix Alpha',
            'Matrix Beta',
        ]);
        expect(primaryAttempts).toBe(2);
    });

    it('deduplicates provider matches before slicing the PWA snapshot into pages', async () => {
        playlists.getAllPlaylists.mockReturnValue(of([xtreamPlaylist]));
        dataSource.searchContent.mockResolvedValue([
            xtreamItem({ title: 'Matrix Alpha', xtream_id: 1 }),
            xtreamItem({ title: 'Matrix Alpha', xtream_id: 1 }),
            xtreamItem({ title: 'Matrix Beta', xtream_id: 2 }),
        ]);
        const service = TestBed.inject(GlobalSearchService);

        const firstPage = await service.globalSearchContent(
            'matrix',
            ['movie'],
            false,
            { limit: 1, offset: 0 }
        );
        const secondPage = await service.globalSearchContent(
            'matrix',
            ['movie'],
            false,
            { limit: 1, offset: 1 }
        );

        expect([...firstPage, ...secondPage].map((item) => item.id)).toEqual([
            'xtream-1:movie:1',
            'xtream-1:movie:2',
        ]);
        expect(dataSource.searchContent).toHaveBeenCalledTimes(1);
    });

    it('rebuilds an in-flight snapshot when the parental-lock version changes and fails closed', async () => {
        playlists.getAllPlaylists.mockReturnValue(of([xtreamPlaylist]));
        const firstProviderSearch = createDeferred<XtreamContentItem[]>();
        dataSource.searchContent
            .mockReturnValueOnce(firstProviderSearch.promise)
            .mockResolvedValueOnce([xtreamItem()]);
        const service = TestBed.inject(GlobalSearchService);

        const search = service.globalSearchContent('matrix', ['movie']);
        await waitFor(() => dataSource.searchContent.mock.calls.length === 1);

        parentalLockVersion = 1;
        parentalLock.active.mockReturnValue(true);
        parentalLock.withholdsEverything.mockReturnValue(true);
        firstProviderSearch.resolve([xtreamItem()]);

        await expect(search).resolves.toEqual([]);
        expect(dataSource.searchContent).toHaveBeenCalledTimes(2);
        expect(parentalLock.withholdsEverything).toHaveBeenCalled();
    });

    it('does not publish a PWA search row without a playlist id', async () => {
        playlists.getAllPlaylists.mockReturnValue(
            of([{ ...xtreamPlaylist, _id: '' } as PlaylistMeta])
        );
        dataSource.searchContent.mockResolvedValue([xtreamItem()]);

        await expect(
            TestBed.inject(GlobalSearchService).globalSearchContent('matrix', [
                'movie',
            ])
        ).resolves.toEqual([]);
    });

    it('paginates a successful PWA search without reloading its sources', async () => {
        playlists.getAllPlaylists.mockReturnValue(of([xtreamPlaylist]));
        dataSource.searchContent.mockResolvedValue(
            ['Alpha', 'Beta', 'Gamma', 'Omega', 'Sigma'].map((suffix, index) =>
                xtreamItem({
                    title: `Matrix ${suffix}`,
                    xtream_id: index + 1,
                })
            )
        );
        const service = TestBed.inject(GlobalSearchService);

        const firstPage = await service.globalSearchContent(
            'matrix',
            ['movie'],
            false,
            { limit: 2, offset: 0 }
        );
        const secondPage = await service.globalSearchContent(
            'matrix',
            ['movie'],
            false,
            { limit: 2, offset: 2 }
        );
        const finalPage = await service.globalSearchContent(
            'matrix',
            ['movie'],
            false,
            { limit: 2, offset: 4 }
        );

        expect([
            ...firstPage.map((item) => item.title),
            ...secondPage.map((item) => item.title),
            ...finalPage.map((item) => item.title),
        ]).toEqual([
            'Matrix Alpha',
            'Matrix Beta',
            'Matrix Gamma',
            'Matrix Omega',
            'Matrix Sigma',
        ]);
        expect(dataSource.getPlaylist).toHaveBeenCalledTimes(1);
        expect(dataSource.getContent).toHaveBeenCalledTimes(1);
        expect(dataSource.searchContent).toHaveBeenCalledTimes(1);
    });
});

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Condition was not met');
}
