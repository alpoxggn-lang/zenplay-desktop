import { DestroyRef, inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { TranslateService } from '@ngx-translate/core';
import { distinctUntilChanged, filter, take } from 'rxjs';
import { createLogger } from '@iptvnator/portal/shared/util/logger';

@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
    private readonly destroyRef = inject(DestroyRef);
    private readonly logger = createLogger('PwaUpdateService');
    private readonly snackBar = inject(MatSnackBar);
    private readonly swUpdate = inject(SwUpdate);
    private readonly translate = inject(TranslateService);

    private activationInFlight = false;
    private started = false;

    /** Starts one update listener for the lifetime of the PWA. */
    start(): void {
        if (this.started || !this.swUpdate.isEnabled) {
            return;
        }
        this.started = true;

        this.swUpdate.versionUpdates
            .pipe(
                filter(
                    (event): event is VersionReadyEvent =>
                        event.type === 'VERSION_READY'
                ),
                distinctUntilChanged(
                    (previous, current) =>
                        previous.latestVersion.hash ===
                        current.latestVersion.hash
                ),
                takeUntilDestroyed(this.destroyRef)
            )
            .subscribe(() => this.showReadyNotification());

        void this.swUpdate.checkForUpdate().catch((error: unknown) => {
            this.logger.debug('PWA update check failed:', error);
        });
    }

    private showReadyNotification(): void {
        const notification = this.snackBar.open(
            this.translate.instant('UPDATE_AVAILABLE'),
            this.translate.instant('REFRESH')
        );

        // VERSION_READY never reloads the app by itself. This explicit action
        // prevents an update from interrupting playback unexpectedly.
        notification
            .onAction()
            .pipe(take(1), takeUntilDestroyed(this.destroyRef))
            .subscribe(() => void this.activateAndReload());
    }

    private async activateAndReload(): Promise<void> {
        if (this.activationInFlight) {
            return;
        }
        this.activationInFlight = true;

        try {
            await this.swUpdate.activateUpdate();
            this.reloadPage();
        } catch (error: unknown) {
            this.activationInFlight = false;
            this.logger.error('PWA update activation failed:', error);
        }
    }

    private reloadPage(): void {
        window.location.reload();
    }
}
