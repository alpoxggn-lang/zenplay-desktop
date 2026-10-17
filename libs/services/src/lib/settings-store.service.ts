import {
    EpgSourceSettingsService,
    epgSourceUrlsChanged,
} from './epg-source-settings.service';
import {
    coerceProvidedDefaultOnSettings,
    resolveDefaultOnSettings,
} from './settings-opt-out.util';
import { computed, inject } from '@angular/core';
import {
    patchState,
    signalStore,
    withComputed,
    withHooks,
    withMethods,
    withState,
} from '@ngrx/signals';
import { StorageMap } from '@ngx-pwa/local-storage';
import { firstValueFrom } from 'rxjs';
import {
    ElectronBridgeTrustOptions,
    EpgViewMode,
    Settings,
    STORE_KEY,
    VideoPlayer,
    normalizeAppUpdateChannel,
    normalizeDashboardRailsSettings,
    normalizeEpgOffsetMinutes,
    normalizeParentalLockRelockMinutes,
    normalizeStartupWindowMode,
} from '@iptvnator/shared/interfaces';

import {
    DESKTOP_NATIVE_PLAYER_MIGRATION_VERSION,
    DEFAULT_SETTINGS,
    preferSupportedEmbeddedMpvDefault,
    scheduleEmbeddedMpvPrepare,
    SettingsStorageState,
    verifySavedEmbeddedMpvPlayer,
} from './settings-store.defaults';

export type { SettingsStorageFailure } from './settings-store.defaults';

export const SettingsStore = signalStore(
    { providedIn: 'root' },
    withState<Settings>(DEFAULT_SETTINGS),
    withState<SettingsStorageState>({ storageFailure: null }),
    withComputed((store) => ({
        /**
         * Live EPG panel layout with the `'timeline'` default applied — the
         * single source of truth for the four live hosts, so the fallback is
         * not duplicated per call-site.
         */
        resolvedEpgViewMode: computed<EpgViewMode>(
            () => store.epgViewMode?.() ?? 'timeline'
        ),
        resolvedEpgOffsetMinutes: computed(() =>
            normalizeEpgOffsetMinutes(store.epgOffsetMinutes?.())
        ),
    })),
    withMethods((store, storage = inject(StorageMap)) => {
        const epgSources = inject(EpgSourceSettingsService);
        let settingsLoadPromise: Promise<void> | undefined;
        let playerChoiceClaimed = false;

        return {
            loadSettings() {
                if (settingsLoadPromise) {
                    return settingsLoadPromise;
                }

                settingsLoadPromise = (async () => {
                    const stored = await firstValueFrom(
                        storage.get(STORE_KEY.Settings)
                    );
                    patchState(store, { storageFailure: null });
                    if (stored) {
                        const storedSettings = stored as Partial<Settings>;
                        const hasStoredPlayer = Object.prototype.hasOwnProperty.call(
                            storedSettings,
                            'player'
                        );
                        const desktopPlatform =
                            typeof window === 'undefined'
                                ? undefined
                                : window.electron?.platform;
                        const hasLegacyDesktopWebDefault =
                            hasStoredPlayer &&
                            storedSettings.player === VideoPlayer.VideoJs &&
                            (desktopPlatform === 'win32' ||
                                desktopPlatform === 'darwin') &&
                            (storedSettings.desktopNativePlayerMigrationVersion ??
                                0) < DESKTOP_NATIVE_PLAYER_MIGRATION_VERSION;
                        // On Windows and macOS, a persisted Video.js value from
                        // an older ZenPlay release was the automatic default,
                        // not necessarily a choice. Let the native support
                        // probe claim it once; every player update below records
                        // the marker so a later explicit choice remains final.
                        playerChoiceClaimed ||=
                            hasStoredPlayer && !hasLegacyDesktopWebDefault;
                        patchState(store, {
                            ...DEFAULT_SETTINGS,
                            ...storedSettings,
                            epgOffsetMinutes: normalizeEpgOffsetMinutes(
                                storedSettings.epgOffsetMinutes
                            ),
                            ...resolveDefaultOnSettings(storedSettings),
                            dashboardRails: normalizeDashboardRailsSettings(
                                storedSettings.dashboardRails
                            ),
                            parentalLockEnabled:
                                storedSettings.parentalLockEnabled === true,
                            parentalLockRelockMinutes:
                                normalizeParentalLockRelockMinutes(
                                    storedSettings.parentalLockRelockMinutes
                                ),
                            desktopNativePlayerMigrationVersion:
                                storedSettings.desktopNativePlayerMigrationVersion ??
                                0,
                        });
                        if (hasStoredPlayer) {
                            void this.sanitizeEmbeddedMpvSelection().catch(
                                (error) => {
                                    console.warn(
                                        'Failed to verify embedded MPV support while loading settings.',
                                        error
                                    );
                                }
                            );
                        }
                    }
                    await preferSupportedEmbeddedMpvDefault(
                        () => !playerChoiceClaimed,
                        () =>
                            this.updateSettings({
                                player: VideoPlayer.EmbeddedMpv,
                                desktopNativePlayerMigrationVersion:
                                    DESKTOP_NATIVE_PLAYER_MIGRATION_VERSION,
                            })
                    ).catch((error) => {
                        console.warn(
                            'Failed to save Embedded MPV as the supported desktop default.',
                            error
                        );
                    });
                    await epgSources
                        .synchronize(this.getSettings().epgUrl)
                        .catch((error) => {
                            console.warn(
                                'Could not reconcile cached EPG sources on startup.',
                                error
                            );
                        });
                })().catch((error) => {
                    settingsLoadPromise = undefined;
                    console.error('Failed to load settings:', error);
                    // Keep default settings if loading fails, but remember
                    // that they are defaults-by-failure rather than by choice
                    // so the settings UI can warn about it.
                    patchState(store, { storageFailure: 'load' });
                });

                return settingsLoadPromise;
            },

            async updateSettings(
                settings: Partial<Settings>,
                options: { retryEpgCleanup?: boolean } = {}
            ) {
                if (settings.player !== undefined) {
                    playerChoiceClaimed = true;
                    settings = {
                        ...settings,
                        desktopNativePlayerMigrationVersion:
                            DESKTOP_NATIVE_PLAYER_MIGRATION_VERSION,
                    };
                }
                const previousEpgUrls = store.epgUrl();
                patchState(store, {
                    ...settings,
                    ...coerceProvidedDefaultOnSettings(settings),
                    ...(settings.dashboardRails !== undefined
                        ? {
                              dashboardRails: normalizeDashboardRailsSettings(
                                  settings.dashboardRails
                              ),
                          }
                        : {}),
                    ...(settings.epgOffsetMinutes !== undefined
                        ? {
                              epgOffsetMinutes: normalizeEpgOffsetMinutes(
                                  settings.epgOffsetMinutes
                              ),
                          }
                        : {}),
                    ...(settings.parentalLockEnabled !== undefined
                        ? {
                              parentalLockEnabled:
                                  settings.parentalLockEnabled === true,
                          }
                        : {}),
                    ...(settings.parentalLockRelockMinutes !== undefined
                        ? {
                              parentalLockRelockMinutes:
                                  normalizeParentalLockRelockMinutes(
                                      settings.parentalLockRelockMinutes
                                  ),
                          }
                        : {}),
                });
                // Save the complete settings object, not just the partial update
                const completeSettings = this.getSettings();
                try {
                    await firstValueFrom(
                        storage.set(STORE_KEY.Settings, completeSettings)
                    );
                    patchState(store, { storageFailure: null });
                    if (completeSettings.player === VideoPlayer.EmbeddedMpv) {
                        scheduleEmbeddedMpvPrepare();
                    }
                } catch (error) {
                    console.error('Failed to save settings:', error);
                    // The in-memory patch above already applied, so without
                    // this flag the change looks saved until the next restart.
                    patchState(store, {
                        storageFailure: 'save',
                        epgUrl: previousEpgUrls,
                    });
                    throw error;
                }
                if (
                    epgSourceUrlsChanged(previousEpgUrls, settings.epgUrl) ||
                    options.retryEpgCleanup
                ) {
                    await epgSources.synchronize(completeSettings.epgUrl);
                }
            },

            getSettings() {
                return {
                    player: store.player(),
                    desktopNativePlayerMigrationVersion:
                        store.desktopNativePlayerMigrationVersion?.() ?? 0,
                    webPlayerSharedControls:
                        store.webPlayerSharedControls?.() !== false,
                    playerAmbientMode:
                        store.playerAmbientMode?.() ??
                        DEFAULT_SETTINGS.playerAmbientMode,
                    detailTrailerBackdrop:
                        store.detailTrailerBackdrop?.() ??
                        DEFAULT_SETTINGS.detailTrailerBackdrop,
                    playerUpNextRail:
                        store.playerUpNextRail?.() ??
                        DEFAULT_SETTINGS.playerUpNextRail,
                    playerUpNextCard:
                        store.playerUpNextCard?.() ??
                        DEFAULT_SETTINGS.playerUpNextCard,
                    fullscreenChannelPanel:
                        store.fullscreenChannelPanel?.() ??
                        DEFAULT_SETTINGS.fullscreenChannelPanel,
                    vodAutoFailover:
                        store.vodAutoFailover?.() ??
                        DEFAULT_SETTINGS.vodAutoFailover,
                    m3uVodDetails:
                        store.m3uVodDetails?.() ??
                        DEFAULT_SETTINGS.m3uVodDetails,
                    streamFormat: store.streamFormat(),
                    openStreamOnDoubleClick: store.openStreamOnDoubleClick(),
                    language: store.language(),
                    showCaptions: store.showCaptions(),
                    showDashboard: store.showDashboard(),
                    startupBehavior: store.startupBehavior(),
                    startupWindowMode: normalizeStartupWindowMode(
                        store.startupWindowMode?.()
                    ),
                    updateChannel: normalizeAppUpdateChannel(
                        store.updateChannel?.()
                    ),
                    showExternalPlaybackBar:
                        store.showExternalPlaybackBar?.() ??
                        DEFAULT_SETTINGS.showExternalPlaybackBar,
                    stripCountryPrefix:
                        store.stripCountryPrefix?.() ??
                        DEFAULT_SETTINGS.stripCountryPrefix,
                    theme: store.theme(),
                    mpvPlayerPath: store.mpvPlayerPath(),
                    mpvPlayerArguments: store.mpvPlayerArguments(),
                    mpvReuseInstance: store.mpvReuseInstance(),
                    vlcPlayerPath: store.vlcPlayerPath(),
                    vlcPlayerArguments: store.vlcPlayerArguments(),
                    vlcReuseInstance: store.vlcReuseInstance(),
                    remoteControl: store.remoteControl(),
                    remoteControlPort: store.remoteControlPort(),
                    epgUrl: store.epgUrl(),
                    downloadFolder:
                        store.downloadFolder?.() ??
                        DEFAULT_SETTINGS.downloadFolder,
                    recordingFolder:
                        store.recordingFolder?.() ??
                        DEFAULT_SETTINGS.recordingFolder,
                    embeddedMpvFrameCopy:
                        store.embeddedMpvFrameCopy?.() ?? false,
                    embeddedMpvExtraOptions:
                        store.embeddedMpvExtraOptions?.() ?? '',
                    portalConnectivityGuard:
                        store.portalConnectivityGuard?.() !== false,
                    embeddedMpvAutoReconnect:
                        store.embeddedMpvAutoReconnect?.() !== false,
                    coverSize:
                        store.coverSize?.() ?? DEFAULT_SETTINGS.coverSize,
                    showCoverTitles: store.showCoverTitles?.() !== false,
                    epgViewMode:
                        store.epgViewMode?.() ?? DEFAULT_SETTINGS.epgViewMode,
                    epgOffsetMinutes: normalizeEpgOffsetMinutes(
                        store.epgOffsetMinutes?.()
                    ),
                    dashboardRails: normalizeDashboardRailsSettings(
                        store.dashboardRails?.()
                    ),
                    preferUploadedEpgOverXtream:
                        store.preferUploadedEpgOverXtream?.() ??
                        DEFAULT_SETTINGS.preferUploadedEpgOverXtream,
                    trustedPrivateNetworkEpgUrls:
                        store.trustedPrivateNetworkEpgUrls?.() ??
                        DEFAULT_SETTINGS.trustedPrivateNetworkEpgUrls,
                    trustedInsecureTlsHosts:
                        store.trustedInsecureTlsHosts?.() ??
                        DEFAULT_SETTINGS.trustedInsecureTlsHosts,
                    tmdb: store.tmdb?.() ?? DEFAULT_SETTINGS.tmdb,
                    parentalLockEnabled: store.parentalLockEnabled?.() === true,
                    parentalLockRelockMinutes:
                        normalizeParentalLockRelockMinutes(
                            store.parentalLockRelockMinutes?.()
                        ),
                };
            },

            getDownloadFolder() {
                return (
                    store.downloadFolder?.() ?? DEFAULT_SETTINGS.downloadFolder
                );
            },

            getRecordingFolder() {
                return (
                    store.recordingFolder?.() ??
                    DEFAULT_SETTINGS.recordingFolder
                );
            },

            getTrustOptions(): ElectronBridgeTrustOptions {
                const settings = this.getSettings();
                return {
                    trustedPrivateNetworkEpgUrls:
                        settings.trustedPrivateNetworkEpgUrls ?? [],
                    trustedInsecureTlsHosts:
                        settings.trustedInsecureTlsHosts ?? [],
                };
            },

            getPlayer() {
                return store.player();
            },

            isEmbeddedPlayer() {
                return (
                    store.player() === VideoPlayer.VideoJs ||
                    store.player() === VideoPlayer.Html5Player ||
                    store.player() === VideoPlayer.ArtPlayer ||
                    store.player() === VideoPlayer.EmbeddedMpv
                );
            },

            async sanitizeEmbeddedMpvSelection() {
                const isSaved = () =>
                    store.player() === VideoPlayer.EmbeddedMpv;
                if (isSaved()) {
                    await verifySavedEmbeddedMpvPlayer(isSaved, () =>
                        this.updateSettings({
                            player: DEFAULT_SETTINGS.player,
                        })
                    );
                }
            },
        };
    }),
    withHooks({
        onInit(store) {
            store.loadSettings();
        },
    })
);
