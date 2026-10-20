import {
    applyDefaultAutoSelectFamilyAttemptTimeout,
    AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_FLAG,
} from '@iptvnator/shared/host-health';
import { closeGracefully } from './app/graceful-shutdown';
import { createSingleOriginWebApp } from './app/single-origin-web-app';
import { createWebBackendApp } from './app/web-backend-app';
import { readServerStorageConfig } from './app/storage/storage-config';
import type { ServerStorage } from './app/storage/server-storage';
import { describeStorageError } from './app/storage/storage-route-errors';

async function start(): Promise<void> {
    const attemptTimeout = applyDefaultAutoSelectFamilyAttemptTimeout();
    if (attemptTimeout !== null) {
        console.log(
            `[web-backend] connection attempt timeout set to ${attemptTimeout} ms for IPv6->IPv4 fallback; pass ${AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_FLAG} via NODE_OPTIONS to override`
        );
    }

    const config = readServerStorageConfig();
    let storage: ServerStorage | null = null;
    if (config.enabled) {
        try {
            const { openServerStorage } =
                await import('./app/storage/server-storage.js');
            const openedStorage = await openServerStorage();
            storage = openedStorage;
            console.log(
                `[web-backend] server storage at ${openedStorage.database.path}`
            );
        } catch (error) {
            console.error(
                `[web-backend] server storage could not open: ${describeStorageError(error)}. Check that IPTVNATOR_DATA_DIR is a writable volume.`
            );
            process.exit(1);
        }
    }

    const port = Number(process.env['PORT'] ?? 3000);
    const backend = createWebBackendApp({
        storage,
        accessToken: config.accessToken,
        maxDocumentBytes: config.maxDocumentBytes,
    });
    const staticDirectory = process.env['ZENPLAY_STATIC_DIR']?.trim();
    if (staticDirectory && !process.env['ZENPLAY_XTREAM_URL']?.trim()) {
        throw new Error(
            'ZENPLAY_XTREAM_URL is required when ZENPLAY_STATIC_DIR is enabled'
        );
    }
    const app = staticDirectory
        ? createSingleOriginWebApp({ backend, staticDirectory })
        : backend;
    const configuredHost = process.env['ZENPLAY_LISTEN_HOST']?.trim();
    const listenHost =
        configuredHost || (staticDirectory ? '127.0.0.1' : undefined);
    const onListening = () => {
        console.log(
            `${staticDirectory ? 'ZenPlay PWA' : 'IPTVnator web backend'} listening on http://${listenHost ?? '0.0.0.0'}:${port}`
        );
    };
    const server = listenHost
        ? app.listen(port, listenHost, onListening)
        : app.listen(port, onListening);

    const shutdown = () => {
        void closeGracefully(server).then(() => {
            storage?.database.close();
            process.exit(0);
        });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

void start();
