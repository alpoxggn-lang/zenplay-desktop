import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { ZENPLAY_CATALOG_PATH } from './zenplay.constants';
import {
    zenPlayLoginGuard,
    zenPlaySourcesGuard,
    zenPlayWorkspaceGuard,
} from './zenplay-auth.guards';
import { ZenPlayProfileService } from './zenplay-profile.service';
import { ZenPlaySessionService } from './zenplay-session.service';

describe('ZenPlay route guards', () => {
    let session: { restore: jest.Mock };
    let profiles: { selectedProfile: jest.Mock };
    let router: { parseUrl: jest.Mock };

    beforeEach(() => {
        session = { restore: jest.fn().mockResolvedValue(false) };
        profiles = { selectedProfile: jest.fn(() => null) };
        router = {
            parseUrl: jest.fn(
                (path: string) => ({ path }) as unknown as UrlTree
            ),
        };
        TestBed.configureTestingModule({
            providers: [
                { provide: ZenPlaySessionService, useValue: session },
                { provide: ZenPlayProfileService, useValue: profiles },
                { provide: Router, useValue: router },
            ],
        });
    });

    it('sends a device without the managed source to login', async () => {
        const result = await TestBed.runInInjectionContext(() =>
            zenPlayWorkspaceGuard({} as never, {} as never)
        );

        expect(result).toEqual({ path: '/login' });
    });

    it('requires profile selection before opening the workspace', async () => {
        session.restore.mockResolvedValue(true);

        const result = await TestBed.runInInjectionContext(() =>
            zenPlayWorkspaceGuard({} as never, {} as never)
        );

        expect(result).toEqual({ path: '/profiles' });
    });

    it('skips login only when both source and profile are ready', async () => {
        session.restore.mockResolvedValue(true);
        profiles.selectedProfile.mockReturnValue({ id: 'profile-1' });

        const result = await TestBed.runInInjectionContext(() =>
            zenPlayLoginGuard({} as never, {} as never)
        );

        expect(result).toEqual({ path: ZENPLAY_CATALOG_PATH });
    });

    it('blocks the generic source manager', () => {
        const result = TestBed.runInInjectionContext(() =>
            zenPlaySourcesGuard({} as never, {} as never)
        );

        expect(result).toEqual({ path: ZENPLAY_CATALOG_PATH });
    });
});
