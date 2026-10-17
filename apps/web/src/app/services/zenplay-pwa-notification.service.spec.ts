import { TestBed } from '@angular/core/testing';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import {
    PWA_SERVICE_WORKER_REGISTRATION_DELAY_MS,
    PWA_SERVICE_WORKER_READY_TIMEOUT_MS,
} from './pwa-service-worker.constants';
import {
    ZenPlayPwaNotificationService,
    type ZenPlayPwaNotificationResult,
} from './zenplay-pwa-notification.service';

describe('ZenPlayPwaNotificationService', () => {
    let notificationDescriptor: PropertyDescriptor | undefined;
    let serviceWorkerDescriptor: PropertyDescriptor | undefined;
    let secureContextDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
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
    });

    afterEach(() => {
        restoreProperty(globalThis, 'Notification', notificationDescriptor);
        restoreProperty(navigator, 'serviceWorker', serviceWorkerDescriptor);
        restoreProperty(globalThis, 'isSecureContext', secureContextDescriptor);
        jest.useRealTimers();
        TestBed.resetTestingModule();
    });

    it('updates its state from a permission request made by settings', async () => {
        const requestPermission = jest.fn().mockResolvedValue('granted');
        installBrowserNotificationApi('default', requestPermission);
        configureService(true);

        await TestBed.inject(ZenPlayPwaNotificationService).requestPermission();

        const service = TestBed.inject(ZenPlayPwaNotificationService);
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(service.permission()).toBe('granted');
    });

    it('does not expose permission controls in Electron', async () => {
        const requestPermission = jest.fn().mockResolvedValue('granted');
        installBrowserNotificationApi('default', requestPermission);
        configureService(false);

        const service = TestBed.inject(ZenPlayPwaNotificationService);
        await service.requestPermission();

        expect(service.supported).toBe(false);
        expect(service.permission()).toBe('unsupported');
        expect(requestPermission).not.toHaveBeenCalled();
    });

    it('waits through the cold-start registration window for a delayed worker', async () => {
        jest.useFakeTimers();
        const showNotification = jest.fn().mockResolvedValue(undefined);
        let resolveReady: (
            registration: ServiceWorkerRegistration
        ) => void = () => undefined;
        const ready = new Promise<ServiceWorkerRegistration>((resolve) => {
            resolveReady = resolve;
        });
        installBrowserNotificationApi('granted', jest.fn(), ready);
        configureService(true);

        const result = showExpiryNotification();
        await jest.advanceTimersByTimeAsync(
            PWA_SERVICE_WORKER_REGISTRATION_DELAY_MS + 1
        );
        expect(showNotification).not.toHaveBeenCalled();

        resolveReady({
            showNotification,
        } as unknown as ServiceWorkerRegistration);

        await expect(result).resolves.toBe('shown');
        expect(showNotification).toHaveBeenCalledTimes(1);
    });

    it('stops waiting after the activation grace window', async () => {
        jest.useFakeTimers();
        installBrowserNotificationApi('granted', jest.fn());
        configureService(true);

        const result = showExpiryNotification();
        await jest.advanceTimersByTimeAsync(
            PWA_SERVICE_WORKER_READY_TIMEOUT_MS
        );

        await expect(result).resolves.toBe('failed');
    });

    function showExpiryNotification(): Promise<ZenPlayPwaNotificationResult> {
        return TestBed.inject(
            ZenPlayPwaNotificationService
        ).showExpiryNotification(
            { kind: 'tomorrow', expiresOn: '2026-10-17' },
            'Tu cuenta vence mañana.',
            'account:test:tomorrow:2026-10-17'
        );
    }

    function configureService(isPwa: boolean): void {
        TestBed.configureTestingModule({
            providers: [
                ZenPlayPwaNotificationService,
                {
                    provide: RuntimeCapabilitiesService,
                    useValue: { isPwa },
                },
            ],
        });
    }

    function installBrowserNotificationApi(
        permission: NotificationPermission,
        requestPermission: jest.Mock,
        ready: Promise<ServiceWorkerRegistration> = new Promise(() => undefined)
    ): void {
        Object.defineProperty(globalThis, 'isSecureContext', {
            configurable: true,
            value: true,
        });
        Object.defineProperty(globalThis, 'Notification', {
            configurable: true,
            value: { permission, requestPermission },
        });
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { ready },
        });
    }
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
