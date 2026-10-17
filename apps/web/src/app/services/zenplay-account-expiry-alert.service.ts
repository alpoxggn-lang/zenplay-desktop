import { DestroyRef, Injectable, NgZone, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Store } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import { selectAllPlaylistsMeta } from '@iptvnator/m3u-state';
import {
    PortalStatusService,
    RuntimeCapabilitiesService,
} from '@iptvnator/services';
import {
    buildZenPlayExpiryAlertDedupeKey,
    createZenPlayAccountFingerprint,
    isXtreamAccountPlaylist,
    normalizeXtreamServerUrl,
    type PlaylistMeta,
    resolveZenPlayAccountExpiryAlert,
    type ZenPlayAccountExpiryNotificationRequest,
} from '@iptvnator/shared/interfaces';
import {
    ZENPLAY_PLAYLIST_ID,
    ZENPLAY_SERVER_URL,
} from '../zenplay-auth/zenplay.constants';
import { ZenPlayPwaNotificationService } from './zenplay-pwa-notification.service';
import { loadLocalizedZenPlayExpiryCopy } from './zenplay-account-expiry-message';

export const ZENPLAY_EXPIRY_ALERT_RECHECK_MS = 6 * 60 * 60 * 1000;
export const ZENPLAY_EXPIRY_ALERT_STORAGE_KEY =
    'zenplay:account-expiry-alerts:system:v2';
export const ZENPLAY_EXPIRY_IN_APP_ALERT_STORAGE_KEY =
    'zenplay:account-expiry-alerts:in-app:v1';
const MAX_STORED_ALERT_KEYS = 128;

interface ZenPlayAccountConnection {
    readonly id: string;
    readonly password: string;
    readonly serverUrl: string;
    readonly username: string;
}

interface ZenPlayExpiryElectronBridge {
    onAppResume?: (callback: () => void) => () => void;
    showZenPlayAccountExpiryNotification?: (
        request: ZenPlayAccountExpiryNotificationRequest
    ) => Promise<boolean>;
}

function toZenPlayAccount(
    playlist: PlaylistMeta
): ZenPlayAccountConnection | null {
    if (
        playlist._id !== ZENPLAY_PLAYLIST_ID ||
        !isXtreamAccountPlaylist(playlist)
    ) {
        return null;
    }

    try {
        const serverUrl = normalizeXtreamServerUrl(playlist.serverUrl);
        if (serverUrl !== ZENPLAY_SERVER_URL) return null;
        return {
            id: playlist._id,
            password: playlist.password.trim(),
            serverUrl,
            username: playlist.username.trim(),
        };
    } catch {
        return null;
    }
}

@Injectable({ providedIn: 'root' })
export class ZenPlayAccountExpiryAlertService {
    private readonly destroyRef = inject(DestroyRef);
    private readonly ngZone = inject(NgZone);
    private readonly portalStatus = inject(PortalStatusService);
    private readonly pwaNotifications = inject(ZenPlayPwaNotificationService);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly snackBar = inject(MatSnackBar);
    private readonly store = inject(Store);
    private readonly translate = inject(TranslateService);

    private readonly notifiedKeys = this.readNotifiedKeys(
        ZENPLAY_EXPIRY_ALERT_STORAGE_KEY
    );
    private readonly shownInAppKeys = this.readNotifiedKeys(
        ZENPLAY_EXPIRY_IN_APP_ALERT_STORAGE_KEY
    );
    private readonly accountEvaluations = new Map<string, Promise<void>>();
    private readonly pendingSystemNotifications = new Set<string>();
    private accounts: readonly ZenPlayAccountConnection[] = [];
    private evaluating = false;
    private evaluateAgain = false;
    private intervalId: number | null = null;
    private removeResumeListener: (() => void) | null = null;
    private started = false;

    private readonly onVisibilityChange = () => {
        if (document.visibilityState === 'visible') this.requestEvaluation();
    };

    constructor() {
        this.destroyRef.onDestroy(() => this.stop());
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        if (
            !this.runtime.isPwa &&
            !this.runtime.isWindows &&
            !this.runtime.isMacOS
        ) {
            return;
        }

        this.store
            .select(selectAllPlaylistsMeta)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((playlists) => {
                this.accounts = playlists
                    .map(toZenPlayAccount)
                    .filter(
                        (account): account is ZenPlayAccountConnection =>
                            account !== null
                    );
                this.requestEvaluation();
            });

        const bridge = this.getExpiryBridge();
        if (typeof bridge.onAppResume === 'function') {
            this.removeResumeListener = bridge.onAppResume(() =>
                this.requestEvaluation()
            );
        }
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        this.ngZone.runOutsideAngular(() => {
            this.intervalId = window.setInterval(
                () => this.requestEvaluation(),
                ZENPLAY_EXPIRY_ALERT_RECHECK_MS
            );
        });
    }

    async notifyBeforeExpiredSessionClear(
        username: string,
        password: string
    ): Promise<void> {
        await this.evaluateAccount({
            id: ZENPLAY_PLAYLIST_ID,
            password: password.trim(),
            serverUrl: ZENPLAY_SERVER_URL,
            username: username.trim(),
        });
    }

    private stop(): void {
        if (this.intervalId !== null) window.clearInterval(this.intervalId);
        this.intervalId = null;
        this.removeResumeListener?.();
        this.removeResumeListener = null;
        document.removeEventListener(
            'visibilitychange',
            this.onVisibilityChange
        );
    }

    private requestEvaluation(): void {
        if (this.evaluating) {
            this.evaluateAgain = true;
            return;
        }
        this.evaluating = true;
        void this.runEvaluationLoop();
    }

    private async runEvaluationLoop(): Promise<void> {
        try {
            do {
                this.evaluateAgain = false;
                await Promise.all(
                    this.accounts.map((account) =>
                        this.evaluateAccount(account)
                    )
                );
            } while (this.evaluateAgain);
        } finally {
            this.evaluating = false;
        }
    }

    private evaluateAccount(account: ZenPlayAccountConnection): Promise<void> {
        const accountKey = createZenPlayAccountFingerprint(
            account.id,
            account.serverUrl,
            account.username
        );
        const pending = this.accountEvaluations.get(accountKey);
        if (pending) return pending;

        const evaluation = this.performAccountEvaluation(account).finally(
            () => {
                if (this.accountEvaluations.get(accountKey) === evaluation) {
                    this.accountEvaluations.delete(accountKey);
                }
            }
        );
        this.accountEvaluations.set(accountKey, evaluation);
        return evaluation;
    }

    private async performAccountEvaluation(
        account: ZenPlayAccountConnection
    ): Promise<void> {
        try {
            const details = await this.portalStatus.checkPortalStatusDetails(
                account.serverUrl,
                account.username,
                account.password
            );
            if (details.status !== 'active' && details.status !== 'expired') {
                return;
            }

            const alert = resolveZenPlayAccountExpiryAlert(
                details.expiresAtSeconds,
                new Date()
            );
            if (!alert) return;

            const fingerprint = createZenPlayAccountFingerprint(
                account.id,
                account.serverUrl,
                account.username
            );
            const dedupeKey = buildZenPlayExpiryAlertDedupeKey(
                fingerprint,
                alert
            );
            const copy = await loadLocalizedZenPlayExpiryCopy(
                alert,
                this.translate
            );
            if (!copy) return;
            if (!this.shownInAppKeys.has(dedupeKey)) {
                this.shownInAppKeys.add(dedupeKey);
                this.persistNotifiedKeys(
                    ZENPLAY_EXPIRY_IN_APP_ALERT_STORAGE_KEY,
                    this.shownInAppKeys
                );
                this.ngZone.run(() => {
                    this.snackBar.open(copy.body, copy.closeLabel, {
                        duration: 12_000,
                    });
                });
            }

            this.scheduleSystemNotification(alert, copy, dedupeKey);
        } catch {
            // Unknown/offline is not an expiry alert.
        }
    }

    private scheduleSystemNotification(
        alert: Parameters<
            ZenPlayPwaNotificationService['showExpiryNotification']
        >[0],
        copy: { readonly body: string; readonly title: string },
        dedupeKey: string
    ): void {
        if (
            this.notifiedKeys.has(dedupeKey) ||
            this.pendingSystemNotifications.has(dedupeKey)
        ) {
            return;
        }

        this.pendingSystemNotifications.add(dedupeKey);
        void this.deliverSystemNotification(alert, copy, dedupeKey).finally(
            () => this.pendingSystemNotifications.delete(dedupeKey)
        );
    }

    private async deliverSystemNotification(
        alert: Parameters<
            ZenPlayPwaNotificationService['showExpiryNotification']
        >[0],
        copy: { readonly body: string; readonly title: string },
        dedupeKey: string
    ): Promise<void> {
        try {
            const showSystemNotification =
                this.runtime.isWindows || this.runtime.isMacOS
                    ? this.getExpiryBridge()
                          .showZenPlayAccountExpiryNotification
                    : undefined;
            if (typeof showSystemNotification === 'function') {
                const shown = await showSystemNotification({
                    ...alert,
                    body: copy.body,
                    title: copy.title,
                }).catch(() => false);
                if (shown) this.rememberSystemNotification(dedupeKey);
                return;
            }

            if (this.runtime.isPwa) {
                const result =
                    await this.pwaNotifications.showExpiryNotification(
                        alert,
                        copy.body,
                        dedupeKey
                    );
                if (result === 'shown') {
                    this.rememberSystemNotification(dedupeKey);
                }
            }
        } catch {
            // Delivery can be retried on the next visibility/resume/interval pass.
        }
    }

    private getExpiryBridge(): ZenPlayExpiryElectronBridge {
        return (window.electron ??
            {}) as unknown as ZenPlayExpiryElectronBridge;
    }

    private readNotifiedKeys(storageKey: string): Set<string> {
        try {
            const value = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
            if (!Array.isArray(value)) return new Set();
            return new Set(
                value
                    .filter(
                        (key): key is string =>
                            typeof key === 'string' && key.length <= 160
                    )
                    .slice(-MAX_STORED_ALERT_KEYS)
            );
        } catch {
            return new Set();
        }
    }

    private rememberSystemNotification(key: string): void {
        this.notifiedKeys.add(key);
        this.persistNotifiedKeys(
            ZENPLAY_EXPIRY_ALERT_STORAGE_KEY,
            this.notifiedKeys
        );
    }

    private persistNotifiedKeys(storageKey: string, keys: Set<string>): void {
        while (keys.size > MAX_STORED_ALERT_KEYS) {
            const oldest = keys.values().next().value;
            if (typeof oldest !== 'string') break;
            keys.delete(oldest);
        }
        try {
            localStorage.setItem(storageKey, JSON.stringify([...keys]));
        } catch {
            // In-memory dedupe still protects this process when storage fails.
        }
    }
}
