import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ZENPLAY_CATALOG_PATH } from './zenplay.constants';
import { ZenPlayProfileService } from './zenplay-profile.service';
import { ZenPlaySessionService } from './zenplay-session.service';

export const zenPlayLoginGuard: CanActivateFn = async () => {
    const session = inject(ZenPlaySessionService);
    const profiles = inject(ZenPlayProfileService);
    const router = inject(Router);
    if (!(await session.restore())) {
        return true;
    }
    return router.parseUrl(
        profiles.selectedProfile() ? ZENPLAY_CATALOG_PATH : '/profiles'
    );
};

export const zenPlayProfilesGuard: CanActivateFn = async () => {
    const session = inject(ZenPlaySessionService);
    const router = inject(Router);
    const connected = await session.restore();
    return connected ? true : router.parseUrl('/login');
};

export const zenPlayWorkspaceGuard: CanActivateFn = async () => {
    const router = inject(Router);
    const session = inject(ZenPlaySessionService);
    const profiles = inject(ZenPlayProfileService);
    if (!(await session.restore())) {
        return router.parseUrl('/login');
    }
    return profiles.selectedProfile()
        ? true
        : router.parseUrl('/profiles');
};

export const zenPlaySourcesGuard: CanActivateFn = () =>
    inject(Router).parseUrl(ZENPLAY_CATALOG_PATH);
