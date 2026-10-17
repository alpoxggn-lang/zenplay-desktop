import { Injectable, inject, signal } from '@angular/core';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import { type ZenPlayAccountExpiryAlert } from '@iptvnator/shared/interfaces';
import { PWA_SERVICE_WORKER_READY_TIMEOUT_MS } from './pwa-service-worker.constants';

export const ZENPLAY_SERVICE_WORKER_READY_TIMEOUT_MS =
    PWA_SERVICE_WORKER_READY_TIMEOUT_MS;
export const ZENPLAY_EXPIRY_SETTINGS_ROUTE = 'workspace/settings/general';

export type ZenPlayPwaNotificationPermission =
    NotificationPermission | 'unsupported';
export type ZenPlayPwaNotificationResult = 'shown' | 'unavailable' | 'failed';

@Injectable({ providedIn: 'root' })
export class ZenPlayPwaNotificationService {
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly permissionState = signal<ZenPlayPwaNotificationPermission>(
        this.readPermission()
    );

    readonly permission = this.permissionState.asReadonly();
    readonly requestingPermission = signal(false);

    get supported(): boolean {
        return (
            this.runtime.isPwa &&
            globalThis.isSecureContext !== false &&
            typeof globalThis.Notification !== 'undefined' &&
            typeof globalThis.Notification.requestPermission === 'function' &&
            typeof globalThis.navigator !== 'undefined' &&
            'serviceWorker' in globalThis.navigator
        );
    }

    refreshPermission(): void {
        this.permissionState.set(this.readPermission());
    }

    /** Must be called directly from a user interaction such as a button click. */
    async requestPermission(): Promise<void> {
        if (!this.supported || this.requestingPermission()) return;

        this.requestingPermission.set(true);
        try {
            const permission =
                await globalThis.Notification.requestPermission();
            this.permissionState.set(permission);
        } catch {
            this.refreshPermission();
        } finally {
            this.requestingPermission.set(false);
        }
    }

    async showExpiryNotification(
        alert: ZenPlayAccountExpiryAlert,
        body: string,
        dedupeKey: string
    ): Promise<ZenPlayPwaNotificationResult> {
        this.refreshPermission();
        if (!this.supported || this.permission() !== 'granted') {
            return 'unavailable';
        }

        try {
            const registration = await this.waitForServiceWorkerReady();
            await registration.showNotification('ZenPlay', {
                body,
                icon: 'assets/branding/zenplay-icon-192.png',
                badge: 'assets/branding/zenplay-icon-192.png',
                tag: `zenplay-expiry-${dedupeKey}`,
                data: {
                    kind: alert.kind,
                    expiresOn: alert.expiresOn,
                    onActionClick: {
                        default: {
                            operation: 'navigateLastFocusedOrOpen',
                            url: ZENPLAY_EXPIRY_SETTINGS_ROUTE,
                        },
                    },
                },
            });
            return 'shown';
        } catch {
            return 'failed';
        }
    }

    private readPermission(): ZenPlayPwaNotificationPermission {
        return this.supported
            ? globalThis.Notification.permission
            : 'unsupported';
    }

    private waitForServiceWorkerReady(): Promise<ServiceWorkerRegistration> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeoutId = globalThis.setTimeout(() => {
                settled = true;
                reject(new Error('Service worker readiness timed out'));
            }, ZENPLAY_SERVICE_WORKER_READY_TIMEOUT_MS);

            globalThis.navigator.serviceWorker.ready.then(
                (registration) => {
                    if (settled) return;
                    settled = true;
                    globalThis.clearTimeout(timeoutId);
                    resolve(registration);
                },
                (error: unknown) => {
                    if (settled) return;
                    settled = true;
                    globalThis.clearTimeout(timeoutId);
                    reject(error);
                }
            );
        });
    }
}
