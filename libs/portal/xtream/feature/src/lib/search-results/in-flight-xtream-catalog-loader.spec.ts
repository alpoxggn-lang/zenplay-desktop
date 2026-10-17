import { IXtreamDataSource } from '@iptvnator/portal/xtream/data-access';
import {
    createInFlightXtreamCatalogLoader,
    PWA_CATALOG_LOAD_CONCURRENCY,
} from './in-flight-xtream-catalog-loader';

describe('createInFlightXtreamCatalogLoader', () => {
    it('limits slow catalog loads across playlists while preserving queued work', async () => {
        let active = 0;
        let maxActive = 0;
        let completed = 0;
        const releases: Array<() => void> = [];
        const getContent = jest.fn(
            () =>
                new Promise<unknown>((resolve) => {
                    active++;
                    maxActive = Math.max(maxActive, active);
                    releases.push(() => {
                        active--;
                        completed++;
                        resolve([]);
                    });
                })
        );
        const loader = createInFlightXtreamCatalogLoader(
            { getContent } as unknown as IXtreamDataSource,
            PWA_CATALOG_LOAD_CONCURRENCY
        );
        const credentials = {
            serverUrl: 'https://provider.test',
            username: 'user',
            password: 'pass',
        };

        const loads = ['one', 'two', 'three'].flatMap((playlistId) =>
            (['live', 'movie', 'series'] as const).map((type) =>
                loader(playlistId, credentials, type)
            )
        );

        expect(getContent).toHaveBeenCalledTimes(PWA_CATALOG_LOAD_CONCURRENCY);
        while (completed < loads.length) {
            const release = releases.shift();
            if (release) {
                release();
            }
            await Promise.resolve();
            await Promise.resolve();
        }
        await Promise.all(loads);

        expect(getContent).toHaveBeenCalledTimes(loads.length);
        expect(maxActive).toBe(PWA_CATALOG_LOAD_CONCURRENCY);
    });

    it('deduplicates a queued or active playlist/type request', async () => {
        let release!: () => void;
        const getContent = jest.fn(
            () =>
                new Promise<unknown>((resolve) => {
                    release = () => resolve([]);
                })
        );
        const loader = createInFlightXtreamCatalogLoader(
            { getContent } as unknown as IXtreamDataSource,
            1
        );
        const credentials = {
            serverUrl: 'https://provider.test',
            username: 'user',
            password: 'pass',
        };

        const first = loader('one', credentials, 'movie');
        const duplicate = loader('one', credentials, 'movie');

        expect(duplicate).toBe(first);
        expect(getContent).toHaveBeenCalledTimes(1);
        release();
        await Promise.all([first, duplicate]);
    });
});
