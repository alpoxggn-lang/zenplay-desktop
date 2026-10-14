import {
    ChangeDetectionStrategy,
    Component,
    computed,
    input,
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import {
    PortalRailLink,
    PortalRailSection,
} from '@iptvnator/portal/shared/util';
import { WorkspaceShellRailLinksComponent } from '../workspace-shell-rail-links/workspace-shell-rail-links.component';

@Component({
    selector: 'app-workspace-shell-rail',
    imports: [
        MatIcon,
        MatTooltip,
        RouterLink,
        RouterLinkActive,
        TranslatePipe,
        WorkspaceShellRailLinksComponent,
    ],
    templateUrl: './workspace-shell-rail.component.html',
    styleUrl: './workspace-shell-rail.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceShellRailComponent {
    readonly isMacOS = input(false);
    readonly workspaceLinks = input<PortalRailLink[]>([]);
    readonly primaryContextLinks = input<PortalRailLink[]>([]);
    readonly secondaryContextLinks = input<PortalRailLink[]>([]);
    readonly selectedSection = input<
        PortalRailSection | string | null | undefined
    >(null);
    readonly railProviderClass = input('rail-context-region');
    readonly isSettingsRoute = input(false);
    readonly supportsDownloads = input(true);

    readonly zenPlayNavigationItems = computed(() => {
        const workspaceLinks = this.workspaceLinks();
        const portalLinks = [
            ...this.primaryContextLinks(),
            ...this.secondaryContextLinks(),
        ];
        const home =
            workspaceLinks.find((link) =>
                link.path.map(String).join('/').endsWith('/workspace/dashboard')
            ) ??
            workspaceLinks.find((link) =>
                link.path.map(String).join('/').endsWith('/workspace/sources')
            );
        const findSection = (...sections: PortalRailSection[]) =>
            portalLinks.find(
                (link) => link.section && sections.includes(link.section)
            );

        return [
            {
                id: 'home',
                icon: 'home',
                labelKey: 'WORKSPACE.SHELL.RAIL_DASHBOARD',
                path: home?.path ?? ['/workspace/dashboard'],
                exact: true,
            },
            this.toZenPlayItem(
                'live',
                'live_tv',
                'WORKSPACE.SHELL.RAIL_LIVE',
                findSection('live', 'itv'),
                'live'
            ),
            this.toZenPlayItem(
                'movies',
                'movie',
                'WORKSPACE.SHELL.RAIL_MOVIES',
                findSection('vod'),
                'vod'
            ),
            this.toZenPlayItem(
                'series',
                'tv',
                'WORKSPACE.SHELL.RAIL_SERIES',
                findSection('series'),
                'series'
            ),
            ...(this.supportsDownloads()
                ? [
                      {
                          id: 'downloads',
                          icon: 'download',
                          labelKey: 'WORKSPACE.SHELL.RAIL_DOWNLOADS',
                          path: ['/workspace/downloads'],
                          exact: false,
                      },
                  ]
                : []),
        ];
    });

    private toZenPlayItem(
        id: string,
        icon: string,
        labelKey: string,
        link: PortalRailLink | undefined,
        fallbackSection: 'live' | 'vod' | 'series'
    ) {
        return {
            id,
            icon,
            labelKey,
            path: link?.path ?? [
                '/workspace',
                'xtreams',
                'zenplay-primary',
                fallbackSection,
            ],
            exact: link?.exact ?? false,
        };
    }
}
