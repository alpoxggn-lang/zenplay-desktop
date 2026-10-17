import { provideHttpClient } from '@angular/common/http';
import {
    HttpTestingController,
    provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
    PlaylistsService,
    XtreamConnectionTestService,
} from '@iptvnator/services';
import { of, throwError } from 'rxjs';
import { ZENPLAY_PLAYLIST_ID, ZENPLAY_SERVER_URL } from './zenplay.constants';
import { ZenPlayProfileService } from './zenplay-profile.service';
import { ZenPlaySessionService } from './zenplay-session.service';
import { ZenPlayAccountExpiryAlertService } from '../services/zenplay-account-expiry-alert.service';

describe('ZenPlaySessionService', () => {
    let connectionTest: { test: jest.Mock };
    let http: HttpTestingController;
    let expiryAlerts: { notifyBeforeExpiredSessionClear: jest.Mock };
    let playlists: {
        deletePlaylist: jest.Mock;
        getPlaylistById: jest.Mock;
    };
    let profiles: { requireSelection: jest.Mock };

    const storedConnection = {
        _id: ZENPLAY_PLAYLIST_ID,
        serverUrl: ZENPLAY_SERVER_URL,
        username: 'cliente',
        password: 'clave',
    };

    beforeEach(() => {
        connectionTest = {
            test: jest.fn().mockResolvedValue({ status: 'active' }),
        };
        expiryAlerts = {
            notifyBeforeExpiredSessionClear: jest
                .fn()
                .mockResolvedValue(undefined),
        };
        playlists = {
            deletePlaylist: jest.fn(() => of({ success: true })),
            getPlaylistById: jest.fn(() => of(storedConnection)),
        };
        profiles = { requireSelection: jest.fn() };
        TestBed.configureTestingModule({
            providers: [
                ZenPlaySessionService,
                provideHttpClient(),
                provideHttpClientTesting(),
                {
                    provide: XtreamConnectionTestService,
                    useValue: connectionTest,
                },
                { provide: PlaylistsService, useValue: playlists },
                { provide: ZenPlayProfileService, useValue: profiles },
                {
                    provide: ZenPlayAccountExpiryAlertService,
                    useValue: expiryAlerts,
                },
            ],
        });
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('restores a persisted login and validates it only once per app run', async () => {
        const service = TestBed.inject(ZenPlaySessionService);

        await expect(service.restore()).resolves.toBe(true);
        await expect(service.restore()).resolves.toBe(true);

        expect(connectionTest.test).toHaveBeenCalledTimes(1);
        expect(connectionTest.test).toHaveBeenCalledWith(
            {
                serverUrl: ZENPLAY_SERVER_URL,
                username: 'cliente',
                password: 'clave',
            },
            expect.any(Function),
            false
        );
    });

    it('keeps the login when the network or restarted backend is unavailable', async () => {
        connectionTest.test.mockResolvedValue({ status: 'unavailable' });

        await expect(
            TestBed.inject(ZenPlaySessionService).restore()
        ).resolves.toBe(true);

        expect(playlists.deletePlaylist).not.toHaveBeenCalled();
        expect(profiles.requireSelection).not.toHaveBeenCalled();
    });

    it.each(['inactive', 'expired'] as const)(
        'clears a provider-confirmed %s login',
        async (status) => {
            connectionTest.test.mockResolvedValue({ status });

            const pending = TestBed.inject(ZenPlaySessionService).restore();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const request = http.expectOne(
                'http://localhost:3000/media/session'
            );
            expect(request.request.method).toBe('DELETE');
            expect(request.request.withCredentials).toBe(true);
            request.flush({});

            await expect(pending).resolves.toBe(false);
            expect(playlists.deletePlaylist).toHaveBeenCalledWith(
                ZENPLAY_PLAYLIST_ID
            );
            expect(profiles.requireSelection).toHaveBeenCalledTimes(1);
            if (status === 'expired') {
                expect(
                    expiryAlerts.notifyBeforeExpiredSessionClear
                ).toHaveBeenCalledWith('cliente', 'clave');
            } else {
                expect(
                    expiryAlerts.notifyBeforeExpiredSessionClear
                ).not.toHaveBeenCalled();
            }
        }
    );

    it('awaits the expiry-day warning before deleting an expired session', async () => {
        connectionTest.test.mockResolvedValue({ status: 'expired' });
        let releaseAlert!: () => void;
        expiryAlerts.notifyBeforeExpiredSessionClear.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    releaseAlert = resolve;
                })
        );

        const pending = TestBed.inject(ZenPlaySessionService).restore();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            expiryAlerts.notifyBeforeExpiredSessionClear
        ).toHaveBeenCalledWith('cliente', 'clave');
        expect(playlists.deletePlaylist).not.toHaveBeenCalled();
        expect(profiles.requireSelection).not.toHaveBeenCalled();
        http.expectNone('http://localhost:3000/media/session');

        releaseAlert();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const request = http.expectOne('http://localhost:3000/media/session');
        request.flush({});

        await expect(pending).resolves.toBe(false);
        expect(playlists.deletePlaylist).toHaveBeenCalledWith(
            ZENPLAY_PLAYLIST_ID
        );
    });

    it('does not sign out when persistent storage is temporarily unreadable', async () => {
        playlists.getPlaylistById.mockReturnValue(
            throwError(() => new Error('storage unavailable'))
        );

        await expect(
            TestBed.inject(ZenPlaySessionService).restore()
        ).resolves.toBe(false);

        expect(connectionTest.test).not.toHaveBeenCalled();
        expect(playlists.deletePlaylist).not.toHaveBeenCalled();
    });

    it('reuses the successful login result without probing again', async () => {
        const service = TestBed.inject(ZenPlaySessionService);
        service.rememberAuthenticated(' cliente ', ' clave ');

        await expect(service.restore()).resolves.toBe(true);
        expect(connectionTest.test).not.toHaveBeenCalled();
    });
});
