import { DestroyRef, Injectable, NgZone, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Store } from '@ngrx/store';
import { selectAllPlaylistsMeta } from '@iptvnator/m3u-state';
import {
    PortalStatusService,
    RuntimeCapabilitiesService,
} from '@iptvnator/services';
import {
    buildZenPlayExpiryAlertDedupeKey,
    createZenPlayAccountFingerprint,
    formatZenPlayAccountExpiryMessage,
    isXtreamAccountPlaylist,
    normalizeXtreamServerUrl,
    type PlaylistMeta,
    resolveZenPlayAccountExpiryAlert,
    type ZenPlayAccountExpiryAlert,
} from '@iptvnator/shared/interfaces';
import {
    ZENPLAY_PLAYLIST_ID,
    ZENPLAY_SERVER_URL,
} from '../zenplay-auth/zenplay.constants';

export const ZENPLAY_EXPIRY_ALERT_RECHECK_MS = 6 * 60 * 60 * 1000;
export const ZENPLAY_EXPIRY_ALERT_STORAGE_KEY =
    'zenplay:account-expiry-alerts:v1';
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
        request: ZenPlayAccountExpiryAlert
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
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly snackBar = inject(MatSnackBar);
    private readonly store = inject(Store);

    private readonly notifiedKeys = this.readNotifiedKeys();
    private readonly shownInAppKeys = new Set<string>();
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
        if (!this.runtime.isWindows && !this.runtime.isMacOS) return;

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

    private async evaluateAccount(
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
            if (this.notifiedKeys.has(dedupeKey)) return;

            const message = formatZenPlayAccountExpiryMessage(alert);
            if (!message) return;
            if (!this.shownInAppKeys.has(dedupeKey)) {
                this.shownInAppKeys.add(dedupeKey);
                this.ngZone.run(() => {
                    this.snackBar.open(message, 'Cerrar', {
                        duration: 12_000,
                    });
                });
            }

            const showSystemNotification =
                this.getExpiryBridge().showZenPlayAccountExpiryNotification;
            if (typeof showSystemNotification === 'function') {
                const shown = await showSystemNotification(alert).catch(
                    () => false
                );
                if (shown) this.remember(dedupeKey);
            } else {
                // No system-notification bridge exists on this runtime, so
                // the in-app alert is the complete delivery for this day.
                this.remember(dedupeKey);
            }
        } catch {
            // Offline/error is unknown, never an expiry alert.
        }
    }

    private getExpiryBridge(): ZenPlayExpiryElectronBridge {
        return (window.electron ??
            {}) as unknown as ZenPlayExpiryElectronBridge;
    }

    private readNotifiedKeys(): Set<string> {
        try {
            const value = JSON.parse(
                localStorage.getItem(ZENPLAY_EXPIRY_ALERT_STORAGE_KEY) ?? '[]'
            );
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

    private remember(key: string): void {
        this.notifiedKeys.add(key);
        while (this.notifiedKeys.size > MAX_STORED_ALERT_KEYS) {
            const oldest = this.notifiedKeys.values().next().value;
            if (typeof oldest !== 'string') break;
            this.notifiedKeys.delete(oldest);
        }
        try {
            localStorage.setItem(
                ZENPLAY_EXPIRY_ALERT_STORAGE_KEY,
                JSON.stringify([...this.notifiedKeys])
            );
        } catch {
            // In-memory dedupe still protects this process when storage fails.
        }
    }
}
