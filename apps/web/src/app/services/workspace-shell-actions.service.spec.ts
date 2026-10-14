import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { WORKSPACE_SHELL_ACTIONS } from '@iptvnator/workspace/shell/util';
import {
    AppWorkspaceShellActionsService,
    provideWorkspaceShellActions,
} from './workspace-shell-actions.service';
import { ZenPlayContentRefreshService } from './zenplay-content-refresh.service';

describe('AppWorkspaceShellActionsService content refresh', () => {
    const contentRefresh = {
        refresh: jest.fn().mockResolvedValue(undefined),
        canRefresh: jest.fn(() => true),
        refreshing: jest.fn(() => false),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        TestBed.configureTestingModule({
            providers: [
                ...provideWorkspaceShellActions(),
                { provide: MatDialog, useValue: { open: jest.fn() } },
                { provide: Router, useValue: { navigate: jest.fn() } },
                {
                    provide: ZenPlayContentRefreshService,
                    useValue: contentRefresh,
                },
            ],
        });
    });

    it('exposes the shared refresh service through the shell action token', () => {
        const actions = TestBed.inject(WORKSPACE_SHELL_ACTIONS);

        actions.refreshContent?.();

        expect(contentRefresh.refresh).toHaveBeenCalledWith({
            announce: true,
        });
        expect(actions.canRefreshContent?.()).toBe(true);
        expect(actions.isRefreshingContent?.()).toBe(false);
        expect(actions).toBe(TestBed.inject(AppWorkspaceShellActionsService));
    });
});
