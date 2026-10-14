import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { selectAllPlaylistsMeta } from '@iptvnator/m3u-state';
import {
    PortalStatusService,
    RuntimeCapabilitiesService,
} from '@iptvnator/services';
import {
    buildZenPlayExpiryAlertDedupeKey,
    createZenPlayAccountFingerprint,
    type PlaylistMeta,
    resolveZenPlayAccountExpiryAlert,
} from '@iptvnator/shared/interfaces';
import {
    ZENPLAY_PLAYLIST_ID,
    ZENPLAY_SERVER_URL,
} from '../zenplay-auth/zenplay.constants';
import {
    ZENPLAY_EXPIRY_ALERT_RECHECK_MS,
    ZENPLAY_EXPIRY_ALERT_STORAGE_KEY,
    ZenPlayAccountExpiryAlertService,
} from './zenplay-account-expiry-alert.service';

describe('ZenPlayAccountExpiryAlertService', () => {
    const now = new Date(2026, 9, 14, 10, 0);
    const expiresAt = new Date(2026, 9, 15, 18, 0).getTime() / 1000;
    const playlist = {
        _id: ZENPLAY_PLAYLIST_ID,
        title: 'ZenPlay',
        serverUrl: ZENPLAY_SERVER_URL,
        username: 'cliente',
        password: 'secreto',
    } as PlaylistMeta;

    let service: ZenPlayAccountExpiryAlertService;
    let store: MockStore;
    let playlistsSelector: { setResult(value: PlaylistMeta[]): void };
    let portalStatus: { checkPortalStatusDetails: jest.Mock };
    let runtime: { isMacOS: boolean; isWindows: boolean };
    let snackBar: { open: jest.Mock };
    let showSystemNotification: jest.Mock;
    let resumeCallback: (() => void) | undefined;
    let removeResumeListener: jest.Mock;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(now);
        localStorage.removeItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY);
        portalStatus = {
            checkPortalStatusDetails: jest.fn().mockResolvedValue({
                status: 'active',
                expiresAtSeconds: expiresAt,
            }),
        };
        runtime = { isMacOS: false, isWindows: true };
        snackBar = { open: jest.fn() };
        showSystemNotification = jest.fn().mockResolvedValue(true);
        removeResumeListener = jest.fn();
        resumeCallback = undefined;
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: {
                onAppResume: (callback: () => void) => {
                    resumeCallback = callback;
                    return removeResumeListener;
                },
                showZenPlayAccountExpiryNotification: showSystemNotification,
            },
        });

        TestBed.configureTestingModule({
            providers: [
                ZenPlayAccountExpiryAlertService,
                provideMockStore({
                    selectors: [
                        { selector: selectAllPlaylistsMeta, value: [playlist] },
                    ],
                }),
                { provide: PortalStatusService, useValue: portalStatus },
                {
                    provide: RuntimeCapabilitiesService,
                    useValue: runtime,
                },
                { provide: MatSnackBar, useValue: snackBar },
            ],
        });
        store = TestBed.inject(MockStore);
        playlistsSelector = store.overrideSelector(selectAllPlaylistsMeta, [
            playlist,
        ]);
        service = TestBed.inject(ZenPlayAccountExpiryAlertService);
    });

    afterEach(() => {
        TestBed.resetTestingModule();
        jest.useRealTimers();
    });

    async function settle(): Promise<void> {
        await jest.advanceTimersByTimeAsync(0);
    }

    it('shows credential-free in-app and Windows/macOS alerts one day before expiry', async () => {
        service.start();
        await settle();

        expect(snackBar.open).toHaveBeenCalledWith(
            expect.stringContaining('Tu cuenta de ZenPlay vence mañana'),
            'Cerrar',
            { duration: 12_000 }
        );
        expect(showSystemNotification).toHaveBeenCalledWith({
            kind: 'tomorrow',
            expiresOn: '2026-10-15',
        });

        const visiblePayload = JSON.stringify([
            snackBar.open.mock.calls[0],
            showSystemNotification.mock.calls[0],
        ]);
        expect(visiblePayload).not.toContain('cliente');
        expect(visiblePayload).not.toContain('secreto');
        expect(visiblePayload).not.toContain(ZENPLAY_SERVER_URL);

        const stored =
            localStorage.getItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY) ?? '';
        expect(stored).toContain('account:');
        expect(stored).not.toContain('cliente');
        expect(stored).not.toContain(ZENPLAY_SERVER_URL);
    });

    it('deduplicates repeated resume and periodic checks for the same account/date/type', async () => {
        service.start();
        await settle();

        resumeCallback?.();
        await settle();
        await jest.advanceTimersByTimeAsync(ZENPLAY_EXPIRY_ALERT_RECHECK_MS);

        expect(portalStatus.checkPortalStatusDetails).toHaveBeenCalledTimes(3);
        expect(snackBar.open).toHaveBeenCalledTimes(1);
        expect(showSystemNotification).toHaveBeenCalledTimes(1);
    });

    it('retries a failed system notification without repeating the in-app alert', async () => {
        showSystemNotification
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);

        service.start();
        await settle();
        resumeCallback?.();
        await settle();

        expect(snackBar.open).toHaveBeenCalledTimes(1);
        expect(showSystemNotification).toHaveBeenCalledTimes(2);
        expect(
            localStorage.getItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY)
        ).toContain('account:');
    });

    it('emits a distinct expiry-day alert after an OS resume', async () => {
        service.start();
        await settle();

        jest.setSystemTime(new Date(2026, 9, 15, 9, 0));
        resumeCallback?.();
        await settle();

        expect(showSystemNotification).toHaveBeenNthCalledWith(2, {
            kind: 'today',
            expiresOn: '2026-10-15',
        });
        expect(snackBar.open).toHaveBeenCalledTimes(2);
    });

    it('honors persisted dedupe state across app starts', async () => {
        const alert = resolveZenPlayAccountExpiryAlert(expiresAt, now);
        expect(alert).not.toBeNull();
        if (!alert) throw new Error('Expected a day-before expiry alert');
        const fingerprint = createZenPlayAccountFingerprint(
            ZENPLAY_PLAYLIST_ID,
            ZENPLAY_SERVER_URL,
            'cliente'
        );
        localStorage.setItem(
            ZENPLAY_EXPIRY_ALERT_STORAGE_KEY,
            JSON.stringify([
                buildZenPlayExpiryAlertDedupeKey(fingerprint, alert),
            ])
        );

        // Recreate the service so it reads the persisted key like a cold start.
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            providers: [
                ZenPlayAccountExpiryAlertService,
                provideMockStore({
                    selectors: [
                        { selector: selectAllPlaylistsMeta, value: [playlist] },
                    ],
                }),
                { provide: PortalStatusService, useValue: portalStatus },
                {
                    provide: RuntimeCapabilitiesService,
                    useValue: runtime,
                },
                { provide: MatSnackBar, useValue: snackBar },
            ],
        });
        service = TestBed.inject(ZenPlayAccountExpiryAlertService);
        service.start();
        await settle();

        expect(snackBar.open).not.toHaveBeenCalled();
        expect(showSystemNotification).not.toHaveBeenCalled();
    });

    it.each([
        ['unavailable', expiresAt],
        ['inactive', expiresAt],
        ['active', null],
        ['active', 0],
    ] as const)(
        'does not warn for %s status with expiration %s',
        async (status, expiresAtSeconds) => {
            portalStatus.checkPortalStatusDetails.mockResolvedValue({
                status,
                expiresAtSeconds,
            });

            service.start();
            await settle();

            expect(snackBar.open).not.toHaveBeenCalled();
            expect(showSystemNotification).not.toHaveBeenCalled();
        }
    );

    it('treats portal errors as unknown and never creates a false warning', async () => {
        portalStatus.checkPortalStatusDetails.mockRejectedValue(
            new Error('offline')
        );

        service.start();
        await settle();

        expect(snackBar.open).not.toHaveBeenCalled();
        expect(showSystemNotification).not.toHaveBeenCalled();
    });

    it('ignores non-ZenPlay accounts', async () => {
        playlistsSelector.setResult([
            { ...playlist, _id: 'other-xtream' } as PlaylistMeta,
        ]);
        store.refreshState();

        service.start();
        await settle();

        expect(portalStatus.checkPortalStatusDetails).not.toHaveBeenCalled();
        expect(snackBar.open).not.toHaveBeenCalled();
        expect(showSystemNotification).not.toHaveBeenCalled();
    });

    it('does not start outside Windows or macOS desktop', async () => {
        runtime.isWindows = false;

        service.start();
        await settle();

        expect(portalStatus.checkPortalStatusDetails).not.toHaveBeenCalled();
        expect(snackBar.open).not.toHaveBeenCalled();
        expect(showSystemNotification).not.toHaveBeenCalled();
    });
});
