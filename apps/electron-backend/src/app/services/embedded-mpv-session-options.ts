import { resolveEmbeddedMpvSessionOptionArguments } from '@iptvnator/shared/interfaces';
import { app } from 'electron';
import {
    EMBEDDED_MPV_AUTO_RECONNECT,
    EMBEDDED_MPV_EXTRA_OPTIONS,
    store,
} from './store.service';
import { resolveEmbeddedMpvTlsCaOption } from './embedded-mpv-tls-ca-option';

/**
 * Per-session knobs captured when an embedded MPV session is created. They
 * come from the main-process settings mirror (see `store.service.ts`), so a
 * settings change applies to the next session, never to a running one.
 *
 * Read here rather than inside `EmbeddedMpvNativeService`: the config store
 * is constructed at module load and would drag electron-conf into every
 * consumer of the service, including its unit tests.
 */
export interface EmbeddedMpvSessionOptions {
    /**
     * `key=value` lines the addon applies after its built-in options: the
     * app-managed defaults first, then the user's allowed lines.
     */
    extraOptions: string[];
    /** Reload a dropped stream automatically (see `embedded-mpv-reconnect.ts`). */
    autoReconnect: boolean;
}

export function readEmbeddedMpvSessionOptions(): EmbeddedMpvSessionOptions {
    const tlsCaOption = resolveEmbeddedMpvTlsCaOption({
        platform: process.platform,
        isPackaged: app.isPackaged,
        resourcesPath: (process as NodeJS.Process & { resourcesPath?: string })
            .resourcesPath,
    });
    return {
        extraOptions: resolveEmbeddedMpvSessionOptionArguments(
            store.get(EMBEDDED_MPV_EXTRA_OPTIONS, ''),
            tlsCaOption ? [tlsCaOption] : []
        ),
        autoReconnect: store.get(EMBEDDED_MPV_AUTO_RECONNECT, true) !== false,
    };
}
