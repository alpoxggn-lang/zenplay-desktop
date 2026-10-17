import { IXtreamDataSource } from '@iptvnator/portal/xtream/data-access';
import { GlobalSearchContentType } from '@iptvnator/shared/interfaces';

type XtreamCredentials = Parameters<IXtreamDataSource['getContent']>[1];

/**
 * A global cap for PWA catalog hydration. "All" search can otherwise open
 * three requests per Xtream playlist at once, which is enough to overwhelm
 * mobile radios and smaller providers before any useful result is rendered.
 */
export const PWA_CATALOG_LOAD_CONCURRENCY = 4;

function createPromiseQueue(maxConcurrency: number) {
    let active = 0;
    const pending: Array<() => void> = [];

    const drain = () => {
        while (active < maxConcurrency && pending.length > 0) {
            pending.shift()?.();
        }
    };

    return <T>(operation: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            pending.push(() => {
                active++;
                let request: Promise<T>;
                try {
                    request = operation();
                } catch (error) {
                    active--;
                    reject(error);
                    drain();
                    return;
                }
                request.then(resolve, reject).finally(() => {
                    active--;
                    drain();
                });
            });
            drain();
        });
}

export function createInFlightXtreamCatalogLoader(
    dataSource: IXtreamDataSource,
    maxConcurrency = PWA_CATALOG_LOAD_CONCURRENCY
): (
    playlistId: string,
    credentials: XtreamCredentials,
    type: GlobalSearchContentType
) => Promise<unknown> {
    const loads = new Map<string, Promise<unknown>>();
    const enqueue = createPromiseQueue(Math.max(1, maxConcurrency));

    return (playlistId, credentials, type) => {
        const key = `${playlistId}:${type}`;
        let request = loads.get(key);
        if (!request) {
            request = enqueue(() =>
                dataSource.getContent(
                    playlistId,
                    credentials,
                    type,
                    undefined,
                    undefined
                )
            );
            loads.set(key, request);
            request.then(
                () => loads.delete(key),
                () => loads.delete(key)
            );
        }
        return request;
    };
}
