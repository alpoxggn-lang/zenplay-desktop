import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { provideRouter, RouterLinkActive } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { WorkspaceShellRailComponent } from './workspace-shell-rail.component';

@Component({
    selector: 'app-workspace-shell-rail-links',
    template: '',
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: true,
})
class MockWorkspaceShellRailLinksComponent {
    readonly links = input<unknown[]>([]);
    readonly selectedSection = input<string | null>(null);
    readonly activeClass = input('active');
}

describe('WorkspaceShellRailComponent', () => {
    let fixture: ComponentFixture<WorkspaceShellRailComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [WorkspaceShellRailComponent],
            providers: [
                provideRouter([]),
                {
                    provide: TranslateService,
                    useValue: {
                        instant: (key: string) => key,
                        get: (key: string) => of(key),
                        stream: (key: string) => of(key),
                        onLangChange: of(null),
                        onTranslationChange: of(null),
                        onDefaultLangChange: of(null),
                        currentLang: 'en',
                        defaultLang: 'en',
                    },
                },
            ],
        })
            .overrideComponent(WorkspaceShellRailComponent, {
                set: {
                    imports: [
                        MatIcon,
                        MatTooltip,
                        MockWorkspaceShellRailLinksComponent,
                        RouterLink,
                        RouterLinkActive,
                        TranslatePipe,
                    ],
                },
            })
            .compileComponents();

        fixture = TestBed.createComponent(WorkspaceShellRailComponent);
    });

    it('renders provider context region and active settings shortcut state', () => {
        fixture.componentRef.setInput('primaryContextLinks', [
            {
                icon: 'movie',
                tooltip: 'Movies',
                path: ['/workspace', 'xtreams', 'pl-1', 'vod'],
                section: 'vod',
            },
        ]);
        fixture.componentRef.setInput(
            'railProviderClass',
            'rail-context-region rail-context-region--xtreams'
        );
        fixture.componentRef.setInput('isSettingsRoute', true);
        fixture.detectChanges();

        expect(
            fixture.nativeElement.querySelector('.rail-context-region--xtreams')
        ).not.toBeNull();
        expect(
            fixture.nativeElement.querySelector('.rail-shortcut.is-active')
        ).not.toBeNull();
    });

    it('has no brand mark duplicating the first workspace link', () => {
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('img')).toBeNull();
        expect(
            fixture.nativeElement.querySelector('.app-rail')?.firstElementChild
                ?.tagName
        ).toBe('APP-WORKSPACE-SHELL-RAIL-LINKS');
    });

    it('builds the five ZenPlay destinations in the requested order', () => {
        fixture.componentRef.setInput('workspaceLinks', [
            {
                icon: 'dashboard',
                tooltip: 'Inicio',
                path: ['/workspace', 'dashboard'],
            },
        ]);
        fixture.componentRef.setInput('primaryContextLinks', [
            {
                icon: 'movie',
                tooltip: 'Películas',
                path: ['/workspace', 'xtreams', 'pl-1', 'vod'],
                section: 'vod',
            },
            {
                icon: 'live_tv',
                tooltip: 'TV en vivo',
                path: ['/workspace', 'xtreams', 'pl-1', 'live'],
                section: 'live',
            },
            {
                icon: 'tv',
                tooltip: 'Series',
                path: ['/workspace', 'xtreams', 'pl-1', 'series'],
                section: 'series',
            },
        ]);
        fixture.detectChanges();

        const labels = Array.from(
            fixture.nativeElement.querySelectorAll('.zenplay-nav__item span')
        ).map((element: Element) => element.textContent?.trim());

        expect(labels).toEqual([
            'WORKSPACE.SHELL.RAIL_DASHBOARD',
            'WORKSPACE.SHELL.RAIL_LIVE',
            'WORKSPACE.SHELL.RAIL_MOVIES',
            'WORKSPACE.SHELL.RAIL_SERIES',
            'WORKSPACE.SHELL.RAIL_DOWNLOADS',
        ]);
    });

    it('hides the global downloads destination when downloads are unsupported', () => {
        fixture.componentRef.setInput('supportsDownloads', false);
        fixture.detectChanges();

        const labels = Array.from(
            fixture.nativeElement.querySelectorAll('.zenplay-nav__item span')
        ).map((element: Element) => element.textContent?.trim());

        expect(labels).toEqual([
            'WORKSPACE.SHELL.RAIL_DASHBOARD',
            'WORKSPACE.SHELL.RAIL_LIVE',
            'WORKSPACE.SHELL.RAIL_MOVIES',
            'WORKSPACE.SHELL.RAIL_SERIES',
        ]);
        expect(
            fixture.nativeElement.querySelector(
                'a[href="/workspace/downloads"]'
            )
        ).toBeNull();
        expect(
            fixture.nativeElement
                .querySelector('.zenplay-nav__list')
                ?.classList.contains('zenplay-nav__list--four')
        ).toBe(true);
    });

    it('keeps fixed ZenPlay portal destinations available before context loads', () => {
        fixture.detectChanges();

        expect(
            fixture.nativeElement.querySelectorAll(
                '.zenplay-nav__item:disabled'
            ).length
        ).toBe(0);
        expect(
            fixture.nativeElement
                .querySelectorAll('.zenplay-nav__item')[1]
                ?.getAttribute('href')
        ).toContain('/workspace/xtreams/zenplay-primary/live');
    });
});
