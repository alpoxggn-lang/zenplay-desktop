import { createXtreamRoutes } from './xtream-feature.routes';

describe('createXtreamRoutes', () => {
    it('keeps import-driven routes behind the content gate and leaves collections outside it', () => {
        const [xtreamRoute] = createXtreamRoutes();
        const gateRoute = xtreamRoute.children?.find(
            (route) =>
                route.path === '' && typeof route.loadComponent === 'function'
        );

        expect(gateRoute?.children?.map((route) => route.path)).toEqual(
            expect.arrayContaining([
                'live',
                'live/:categoryId',
                'vod',
                'series',
                'search',
                'actor/:personId',
                'discover',
                'recently-added',
            ])
        );

        expect(
            xtreamRoute.children?.find((route) => route.path === 'favorites')
        ).toMatchObject({ path: 'favorites' });
        expect(
            xtreamRoute.children?.find((route) => route.path === 'recent')
        ).toMatchObject({ path: 'recent' });
        expect(
            xtreamRoute.children?.find((route) => route.path === 'downloads')
        ).toMatchObject({ path: 'downloads' });
    });

    it('keeps recently-added collections inside their movie and series sections', () => {
        const [xtreamRoute] = createXtreamRoutes();
        const gateRoute = xtreamRoute.children?.find(
            (route) =>
                route.path === '' && typeof route.loadComponent === 'function'
        );
        const movieRoute = gateRoute?.children?.find(
            (route) => route.path === 'vod'
        );
        const seriesRoute = gateRoute?.children?.find(
            (route) => route.path === 'series'
        );

        expect(movieRoute?.children?.[0]).toMatchObject({
            path: 'recently-added',
            data: { recentlyAddedKind: 'vod' },
        });
        expect(seriesRoute?.children?.[0]).toMatchObject({
            path: 'recently-added',
            data: { recentlyAddedKind: 'series' },
        });
    });
});
