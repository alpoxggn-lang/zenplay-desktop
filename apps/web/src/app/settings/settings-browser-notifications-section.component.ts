import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    inject,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { ZenPlayPwaNotificationService } from '../services/zenplay-pwa-notification.service';

@Component({
    selector: 'app-settings-browser-notifications-section',
    imports: [MatButtonModule, MatIconModule, TranslateModule],
    templateUrl: './settings-browser-notifications-section.component.html',
    styles: [':host { display: contents; }'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsBrowserNotificationsSectionComponent {
    readonly notifications = inject(ZenPlayPwaNotificationService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly refreshPermission = () =>
        this.notifications.refreshPermission();

    constructor() {
        this.refreshPermission();
        window.addEventListener('focus', this.refreshPermission);
        document.addEventListener('visibilitychange', this.refreshPermission);
        this.destroyRef.onDestroy(() => {
            window.removeEventListener('focus', this.refreshPermission);
            document.removeEventListener(
                'visibilitychange',
                this.refreshPermission
            );
        });
    }

    requestPermission(): void {
        void this.notifications.requestPermission();
    }
}
