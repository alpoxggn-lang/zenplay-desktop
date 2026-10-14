import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SwUpdate, VersionEvent } from '@angular/service-worker';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { PwaUpdateService } from './pwa-update.service';

describe('PwaUpdateService', () => {
    let action$: Subject<void>;
    let service: PwaUpdateService;
    let snackBar: { open: jest.Mock };
    let swUpdate: {
        activateUpdate: jest.Mock;
        checkForUpdate: jest.Mock;
        isEnabled: boolean;
        versionUpdates: Subject<VersionEvent>;
    };

    beforeEach(() => {
        action$ = new Subject<void>();
        snackBar = {
            open: jest.fn().mockReturnValue({
                onAction: () => action$.asObservable(),
            }),
        };
        swUpdate = {
            activateUpdate: jest.fn().mockResolvedValue(undefined),
            checkForUpdate: jest.fn().mockResolvedValue(false),
            isEnabled: true,
            versionUpdates: new Subject<VersionEvent>(),
        };

        TestBed.configureTestingModule({
            providers: [
                PwaUpdateService,
                { provide: MatSnackBar, useValue: snackBar },
                { provide: SwUpdate, useValue: swUpdate },
                {
                    provide: TranslateService,
                    useValue: { instant: (key: string) => key },
                },
            ],
        });
        service = TestBed.inject(PwaUpdateService);
    });

    afterEach(() => {
        swUpdate.versionUpdates.complete();
        action$.complete();
    });

    it('does nothing when service workers are disabled', () => {
        swUpdate.isEnabled = false;

        service.start();

        expect(swUpdate.checkForUpdate).not.toHaveBeenCalled();
        expect(snackBar.open).not.toHaveBeenCalled();
    });

    it('starts once and only prompts when a new version is ready', () => {
        service.start();
        service.start();

        expect(swUpdate.checkForUpdate).toHaveBeenCalledTimes(1);

        swUpdate.versionUpdates.next({
            type: 'VERSION_DETECTED',
            version: { hash: 'next' },
        });
        expect(snackBar.open).not.toHaveBeenCalled();

        swUpdate.versionUpdates.next({
            type: 'VERSION_READY',
            currentVersion: { hash: 'current' },
            latestVersion: { hash: 'next' },
        });
        swUpdate.versionUpdates.next({
            type: 'VERSION_READY',
            currentVersion: { hash: 'current' },
            latestVersion: { hash: 'next' },
        });

        expect(snackBar.open).toHaveBeenCalledTimes(1);
        expect(snackBar.open).toHaveBeenCalledWith(
            'UPDATE_AVAILABLE',
            'REFRESH'
        );
        expect(swUpdate.activateUpdate).not.toHaveBeenCalled();
    });

    it('activates and reloads only after the translated action is selected', async () => {
        const reload = jest
            .spyOn(
                service as unknown as { reloadPage: () => void },
                'reloadPage'
            )
            .mockImplementation(() => undefined);
        service.start();
        swUpdate.versionUpdates.next({
            type: 'VERSION_READY',
            currentVersion: { hash: 'current' },
            latestVersion: { hash: 'next' },
        });

        expect(reload).not.toHaveBeenCalled();
        action$.next();
        await Promise.resolve();

        expect(swUpdate.activateUpdate).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
    });
});
