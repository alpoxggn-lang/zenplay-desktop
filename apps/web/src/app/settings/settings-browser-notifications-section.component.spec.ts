import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TranslateModule } from '@ngx-translate/core';
import {
    ZenPlayPwaNotificationPermission,
    ZenPlayPwaNotificationService,
} from '../services/zenplay-pwa-notification.service';
import { SettingsBrowserNotificationsSectionComponent } from './settings-browser-notifications-section.component';

describe('SettingsBrowserNotificationsSectionComponent', () => {
    let fixture: ComponentFixture<SettingsBrowserNotificationsSectionComponent>;
    let permission: ReturnType<typeof signal<ZenPlayPwaNotificationPermission>>;
    let notifications: {
        supported: boolean;
        permission: typeof permission;
        requestingPermission: ReturnType<typeof signal<boolean>>;
        refreshPermission: jest.Mock;
        requestPermission: jest.Mock;
    };

    beforeEach(async () => {
        permission = signal<ZenPlayPwaNotificationPermission>('default');
        notifications = {
            supported: true,
            permission,
            requestingPermission: signal(false),
            refreshPermission: jest.fn(),
            requestPermission: jest.fn().mockResolvedValue(undefined),
        };

        await TestBed.configureTestingModule({
            imports: [
                SettingsBrowserNotificationsSectionComponent,
                TranslateModule.forRoot(),
            ],
            providers: [
                {
                    provide: ZenPlayPwaNotificationService,
                    useValue: notifications,
                },
            ],
        }).compileComponents();
    });

    afterEach(() => TestBed.resetTestingModule());

    function render(): void {
        fixture = TestBed.createComponent(
            SettingsBrowserNotificationsSectionComponent
        );
        fixture.detectChanges();
    }

    it('asks for permission directly from the labelled settings button', () => {
        render();

        const button = fixture.debugElement.query(
            By.css('[data-test-id="enable-browser-notifications"]')
        ).nativeElement as HTMLButtonElement;
        const describedBy = button
            .getAttribute('aria-describedby')
            ?.split(/\s+/);

        expect(describedBy).toEqual([
            'browser-notifications-description',
            'browser-notifications-limitation',
        ]);
        describedBy?.forEach((id) =>
            expect(fixture.nativeElement.querySelector(`#${id}`)).not.toBeNull()
        );

        button.click();
        expect(notifications.requestPermission).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['granted', 'browser-notifications-granted'],
        ['denied', 'browser-notifications-denied'],
    ] as const)('announces the %s permission state', (state, testId) => {
        permission.set(state);
        render();

        const status = fixture.debugElement.query(
            By.css(`[data-test-id="${testId}"]`)
        ).nativeElement as HTMLElement;
        expect(status.getAttribute('role')).toBe('status');
        expect(status.hasAttribute('aria-labelledby')).toBe(false);
        expect(status.textContent?.trim()).not.toBe('');
    });

    it('stays out of the settings UI in unsupported runtimes', () => {
        notifications.supported = false;
        render();

        expect(
            fixture.nativeElement.querySelector(
                '[data-test-id="browser-notifications-setting"]'
            )
        ).toBeNull();
    });

    it('refreshes browser permission after returning to the tab and cleans up', () => {
        render();
        notifications.refreshPermission.mockClear();

        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        expect(notifications.refreshPermission).toHaveBeenCalledTimes(2);

        fixture.destroy();
        notifications.refreshPermission.mockClear();
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        expect(notifications.refreshPermission).not.toHaveBeenCalled();
    });
});
