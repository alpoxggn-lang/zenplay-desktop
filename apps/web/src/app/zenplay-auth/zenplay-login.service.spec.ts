import { TestBed } from '@angular/core/testing';
import { Store } from '@ngrx/store';
import { PlaylistActions } from '@iptvnator/m3u-state';
import { XtreamApiService } from '@iptvnator/portal/xtream/data-access';
import {
    PlaylistsService,
    XtreamConnectionTestService,
} from '@iptvnator/services';
import { of } from 'rxjs';
import { ZENPLAY_PLAYLIST_ID, ZENPLAY_SERVER_URL } from './zenplay.constants';
import { ZenPlayLoginService } from './zenplay-login.service';
import { ZenPlayProfileService } from './zenplay-profile.service';
import { ZenPlaySessionService } from './zenplay-session.service';

describe('ZenPlayLoginService', () => {
    let connectionTest: { test: jest.Mock };
    let xtreamApi: { getCategories: jest.Mock };
    let playlists: {
        addPlaylist: jest.Mock;
        getPlaylistById: jest.Mock;
        transformPlaylistMeta: jest.Mock;
    };
    let profiles: { requireSelection: jest.Mock };
    let session: { rememberAuthenticated: jest.Mock };
    let store: { dispatch: jest.Mock };

    beforeEach(() => {
        connectionTest = {
            test: jest.fn().mockResolvedValue({
                status: 'active',
                serverUrl: ZENPLAY_SERVER_URL,
                usedHttpFallback: false,
            }),
        };
        xtreamApi = {
            getCategories: jest
                .fn()
                .mockResolvedValue([
                    { category_id: '1', category_name: 'Estrenos' },
                ]),
        };
        playlists = {
            addPlaylist: jest.fn((playlist) => of(playlist)),
            getPlaylistById: jest.fn(() => of(undefined)),
            transformPlaylistMeta: jest.fn(() => of(null)),
        };
        profiles = { requireSelection: jest.fn() };
        session = { rememberAuthenticated: jest.fn() };
        store = { dispatch: jest.fn() };

        TestBed.configureTestingModule({
            providers: [
                ZenPlayLoginService,
                {
                    provide: XtreamConnectionTestService,
                    useValue: connectionTest,
                },
                { provide: XtreamApiService, useValue: xtreamApi },
                { provide: PlaylistsService, useValue: playlists },
                { provide: ZenPlayProfileService, useValue: profiles },
                { provide: ZenPlaySessionService, useValue: session },
                { provide: Store, useValue: store },
            ],
        });
    });

    it('validates only the fixed ZenPlay server and persists after finding content', async () => {
        const result = await TestBed.inject(ZenPlayLoginService).login(
            '  cliente  ',
            '  clave  '
        );

        expect(result).toEqual({ ok: true });
        expect(connectionTest.test).toHaveBeenCalledWith(
            {
                serverUrl: ZENPLAY_SERVER_URL,
                username: 'cliente',
                password: 'clave',
            },
            expect.any(Function),
            false
        );
        expect(xtreamApi.getCategories).toHaveBeenCalledTimes(3);
        expect(playlists.addPlaylist).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: ZENPLAY_PLAYLIST_ID,
                serverUrl: ZENPLAY_SERVER_URL,
                username: 'cliente',
                password: 'clave',
            })
        );
        expect(profiles.requireSelection).toHaveBeenCalledTimes(1);
        expect(session.rememberAuthenticated).toHaveBeenCalledWith(
            'cliente',
            'clave'
        );
        expect(store.dispatch).toHaveBeenCalledWith(
            PlaylistActions.loadPlaylists()
        );
    });

    it('does not persist an inactive account', async () => {
        connectionTest.test.mockResolvedValue({
            status: 'inactive',
            serverUrl: ZENPLAY_SERVER_URL,
            usedHttpFallback: false,
        });

        await expect(
            TestBed.inject(ZenPlayLoginService).login('cliente', 'incorrecta')
        ).resolves.toEqual({ ok: false, reason: 'inactive' });
        expect(xtreamApi.getCategories).not.toHaveBeenCalled();
        expect(playlists.addPlaylist).not.toHaveBeenCalled();
    });

    it('rejects an active account whose catalog has no categories', async () => {
        xtreamApi.getCategories.mockResolvedValue([]);

        await expect(
            TestBed.inject(ZenPlayLoginService).login('cliente', 'clave')
        ).resolves.toEqual({ ok: false, reason: 'no-content' });
        expect(playlists.addPlaylist).not.toHaveBeenCalled();
        expect(store.dispatch).not.toHaveBeenCalled();
    });

    it('updates the managed source without deleting profile or viewing data', async () => {
        const current = {
            _id: ZENPLAY_PLAYLIST_ID,
            title: 'Anterior',
            serverUrl: ZENPLAY_SERVER_URL,
            username: 'anterior',
            password: 'anterior',
            importDate: '2026-01-01',
            lastUsage: '2026-01-01',
            count: 0,
            autoRefresh: false,
            favorites: ['movie:7'],
        };
        playlists.getPlaylistById.mockReturnValue(of(current));
        playlists.transformPlaylistMeta.mockImplementation((_id, transform) =>
            of(transform(current))
        );

        await TestBed.inject(ZenPlayLoginService).login('nuevo', 'secreto');

        expect(playlists.addPlaylist).not.toHaveBeenCalled();
        const transform = playlists.transformPlaylistMeta.mock.calls[0][1];
        expect(transform(current)).toEqual(
            expect.objectContaining({
                favorites: ['movie:7'],
                username: 'nuevo',
                password: 'secreto',
            })
        );
    });
});
