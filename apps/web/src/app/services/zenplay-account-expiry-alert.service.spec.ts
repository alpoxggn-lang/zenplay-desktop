import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { TranslateService } from '@ngx-translate/core';
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
import { Observable, Subject, of } from 'rxjs';
import {
    ZENPLAY_PLAYLIST_ID,
    ZENPLAY_SERVER_URL,
} from '../zenplay-auth/zenplay.constants';
import {
    ZENPLAY_EXPIRY_ALERT_RECHECK_MS,
    ZENPLAY_EXPIRY_IN_APP_ALERT_STORAGE_KEY,
    ZENPLAY_EXPIRY_ALERT_STORAGE_KEY,
    ZenPlayAccountExpiryAlertService,
} from './zenplay-account-expiry-alert.service';
import {
    ZENPLAY_EXPIRY_SETTINGS_ROUTE,
    ZENPLAY_SERVICE_WORKER_READY_TIMEOUT_MS,
} from './zenplay-pwa-notification.service';

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
    let runtime: { isMacOS: boolean; isPwa: boolean; isWindows: boolean };
    let snackBar: { open: jest.Mock };
    let translate: {
        currentLang: string;
        getDefaultLang: jest.Mock;
        get: jest.Mock;
        instant: jest.Mock;
    };
    let showSystemNotification: jest.Mock;
    let resumeCallback: (() => void) | undefined;
    let removeResumeListener: jest.Mock;
    let electronDescriptor: PropertyDescriptor | undefined;
    let notificationDescriptor: PropertyDescriptor | undefined;
    let serviceWorkerDescriptor: PropertyDescriptor | undefined;
    let secureContextDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
        electronDescriptor = Object.getOwnPropertyDescriptor(
            window,
            'electron'
        );
        notificationDescriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            'Notification'
        );
        serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
            navigator,
            'serviceWorker'
        );
        secureContextDescriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            'isSecureContext'
        );
        jest.useFakeTimers();
        jest.setSystemTime(now);
        localStorage.removeItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY);
        localStorage.removeItem(ZENPLAY_EXPIRY_IN_APP_ALERT_STORAGE_KEY);
        portalStatus = {
            checkPortalStatusDetails: jest.fn().mockResolvedValue({
                status: 'active',
                expiresAtSeconds: expiresAt,
            }),
        };
        runtime = { isMacOS: false, isPwa: false, isWindows: true };
        snackBar = { open: jest.fn() };
        const translateInstant = (
            key: string,
            params?: { date?: string }
        ): string => {
            const messages: Record<string, Record<string, string>> = {
                en: {
                    CLOSE: 'Close',
                    'SETTINGS.ACCOUNT_EXPIRY_ALERT_TITLE':
                        'ZenPlay · Expiry notice',
                    'SETTINGS.ACCOUNT_EXPIRY_ALERT_TODAY':
                        'Your ZenPlay account expires today ({{date}}).',
                    'SETTINGS.ACCOUNT_EXPIRY_ALERT_TOMORROW':
                        'Your ZenPlay account expires tomorrow ({{date}}).',
                },
                es: {
                    CLOSE: 'Cerrar',
                    'SETTINGS.ACCOUNT_EXPIRY_ALERT_TITLE':
                        'ZenPlay · Aviso de vencimiento',
                    'SETTINGS.ACCOUNT_EXPIRY_ALERT_TODAY':
                        'Tu cuenta de ZenPlay vence hoy ({{date}}).',
                    'SETTINGS.ACCOUNT_EXPIRY_ALERT_TOMORROW':
                        'Tu cuenta de ZenPlay vence mañana ({{date}}).',
                },
            };
            return (messages[translate.currentLang]?.[key] ?? key).replace(
                '{{date}}',
                params?.date ?? ''
            );
        };
        translate = {
            currentLang: 'es',
            getDefaultLang: jest.fn(() => 'es'),
            get: jest.fn(
                (
                    keys: string[],
                    params?: { date?: string }
                ): Observable<unknown> =>
                    of(
                        Object.fromEntries(
                            keys.map((key) => [
                                key,
                                translateInstant(key, params),
                            ])
                        )
                    )
            ),
            instant: jest.fn(translateInstant),
        };
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
                { provide: TranslateService, useValue: translate },
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
        restoreProperty(window, 'electron', electronDescriptor);
        restoreProperty(globalThis, 'Notification', notificationDescriptor);
        restoreProperty(navigator, 'serviceWorker', serviceWorkerDescriptor);
        restoreProperty(globalThis, 'isSecureContext', secureContextDescriptor);
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
            body: 'Tu cuenta de ZenPlay vence mañana (15 de octubre de 2026).',
            kind: 'tomorrow',
            expiresOn: '2026-10-15',
            title: 'ZenPlay · Aviso de vencimiento',
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

    it('waits for cold-start translations before showing and deduplicating', async () => {
        const loadedTranslations = new Subject<Record<string, string>>();
        translate.get.mockReturnValueOnce(loadedTranslations);

        service.start();
        await settle();
        expect(snackBar.open).not.toHaveBeenCalled();
        expect(showSystemNotification).not.toHaveBeenCalled();
        expect(
            localStorage.getItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY)
        ).toBeNull();

        loadedTranslations.next({
            CLOSE: 'Close',
            'SETTINGS.ACCOUNT_EXPIRY_ALERT_TITLE': 'ZenPlay · Expiry notice',
            'SETTINGS.ACCOUNT_EXPIRY_ALERT_TOMORROW':
                'Your ZenPlay account expires tomorrow (October 15, 2026).',
        });
        loadedTranslations.complete();
        await settle();

        expect(snackBar.open).toHaveBeenCalledWith(
            expect.stringContaining('expires tomorrow'),
            'Close',
            { duration: 12_000 }
        );
        expect(showSystemNotification).toHaveBeenCalledTimes(1);
        expect(
            localStorage.getItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY)
        ).toContain('account:');
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

    it('shares a concurrent startup and expired-session evaluation', async () => {
        let releaseStatus!: (value: {
            status: 'expired';
            expiresAtSeconds: number;
        }) => void;
        portalStatus.checkPortalStatusDetails.mockImplementation(
            () =>
                new Promise((resolve) => {
                    releaseStatus = resolve;
                })
        );

        service.start();
        const beforeClear = service.notifyBeforeExpiredSessionClear(
            'cliente',
            'secreto'
        );
        await settle();

        expect(portalStatus.checkPortalStatusDetails).toHaveBeenCalledTimes(1);
        releaseStatus({ status: 'expired', expiresAtSeconds: expiresAt });
        await beforeClear;
        await settle();

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
            body: 'Tu cuenta de ZenPlay vence hoy (15 de octubre de 2026).',
            kind: 'today',
            expiresOn: '2026-10-15',
            title: 'ZenPlay · Aviso de vencimiento',
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
        localStorage.setItem(
            ZENPLAY_EXPIRY_IN_APP_ALERT_STORAGE_KEY,
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
                { provide: TranslateService, useValue: translate },
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

    it('shows the in-app alert and a service-worker notification in the PWA', async () => {
        runtime.isWindows = false;
        runtime.isPwa = true;
        translate.currentLang = 'en';
        const showNotification = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, 'isSecureContext', {
            configurable: true,
            value: true,
        });
        Object.defineProperty(globalThis, 'Notification', {
            configurable: true,
            value: {
                permission: 'granted',
                requestPermission: jest.fn().mockResolvedValue('granted'),
            },
        });
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: {
                ready: Promise.resolve({ showNotification }),
            },
        });

        service.start();
        await settle();

        expect(snackBar.open).toHaveBeenCalledWith(
            'Your ZenPlay account expires tomorrow (October 15, 2026).',
            'Close',
            { duration: 12_000 }
        );
        expect(showNotification).toHaveBeenCalledWith(
            'ZenPlay',
            expect.objectContaining({
                body: 'Your ZenPlay account expires tomorrow (October 15, 2026).',
                icon: 'assets/branding/zenplay-icon-192.png',
                tag: expect.stringMatching(/^zenplay-expiry-.*account:/),
                data: expect.objectContaining({
                    onActionClick: {
                        default: {
                            operation: 'navigateLastFocusedOrOpen',
                            url: ZENPLAY_EXPIRY_SETTINGS_ROUTE,
                        },
                    },
                }),
            })
        );
        expect(showSystemNotification).not.toHaveBeenCalled();
    });

    it('retries PWA delivery after notification permission is enabled', async () => {
        runtime.isWindows = false;
        runtime.isPwa = true;
        const showNotification = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, 'isSecureContext', {
            configurable: true,
            value: true,
        });
        Object.defineProperty(globalThis, 'Notification', {
            configurable: true,
            value: {
                permission: 'default',
                requestPermission: jest.fn().mockResolvedValue('default'),
            },
        });

        service.start();
        await settle();

        expect(snackBar.open).toHaveBeenCalledTimes(1);
        expect(
            localStorage.getItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY)
        ).toBeNull();

        Object.defineProperty(globalThis, 'Notification', {
            configurable: true,
            value: {
                permission: 'granted',
                requestPermission: jest.fn().mockResolvedValue('granted'),
            },
        });
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { ready: Promise.resolve({ showNotification }) },
        });
        await jest.advanceTimersByTimeAsync(ZENPLAY_EXPIRY_ALERT_RECHECK_MS);
        await settle();

        expect(snackBar.open).toHaveBeenCalledTimes(1);
        expect(showNotification).toHaveBeenCalledTimes(1);
        expect(
            localStorage.getItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY)
        ).toContain('account:');
    });

    it('does not block expired-session cleanup on service-worker readiness', async () => {
        runtime.isWindows = false;
        runtime.isPwa = true;
        Object.defineProperty(globalThis, 'isSecureContext', {
            configurable: true,
            value: true,
        });
        Object.defineProperty(globalThis, 'Notification', {
            configurable: true,
            value: {
                permission: 'granted',
                requestPermission: jest.fn().mockResolvedValue('granted'),
            },
        });
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { ready: new Promise(() => undefined) },
        });

        await expect(
            service.notifyBeforeExpiredSessionClear('cliente', 'secreto')
        ).resolves.toBeUndefined();

        expect(snackBar.open).toHaveBeenCalledTimes(1);
        expect(
            localStorage.getItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY)
        ).toBeNull();
        expect(jest.getTimerCount()).toBeGreaterThan(0);
    });

    it('times out service-worker readiness and retries a later evaluation', async () => {
        runtime.isWindows = false;
        runtime.isPwa = true;
        const showNotification = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, 'isSecureContext', {
            configurable: true,
            value: true,
        });
        Object.defineProperty(globalThis, 'Notification', {
            configurable: true,
            value: {
                permission: 'granted',
                requestPermission: jest.fn().mockResolvedValue('granted'),
            },
        });
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { ready: new Promise(() => undefined) },
        });

        service.start();
        await settle();
        expect(portalStatus.checkPortalStatusDetails).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(
            ZENPLAY_SERVICE_WORKER_READY_TIMEOUT_MS
        );
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { ready: Promise.resolve({ showNotification }) },
        });
        await jest.advanceTimersByTimeAsync(
            ZENPLAY_EXPIRY_ALERT_RECHECK_MS -
                ZENPLAY_SERVICE_WORKER_READY_TIMEOUT_MS
        );
        await settle();

        expect(portalStatus.checkPortalStatusDetails).toHaveBeenCalledTimes(2);
        expect(showNotification).toHaveBeenCalledTimes(1);
        expect(
            localStorage.getItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY)
        ).toContain('account:');
    });
});

function restoreProperty(
    target: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor | undefined
): void {
    if (descriptor) {
        Object.defineProperty(target, key, descriptor);
    } else {
        Reflect.deleteProperty(target, key);
    }
}
