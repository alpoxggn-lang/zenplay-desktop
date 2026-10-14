import { inject, Injectable } from '@angular/core';
import {
    formatXtreamCatchupStart,
    normalizeXtreamServerUrl,
    StreamFormat,
    XtreamSerieEpisode,
    XtreamVodDetails,
} from '@iptvnator/shared/interfaces';
import {
    DatabaseService,
    RuntimeCapabilitiesService,
    SettingsStore,
} from '@iptvnator/services';
import { XtreamCredentials } from './xtream-api.service';
import { resolveXtreamVodPlaybackSource } from './xtream-vod-playback-source';

/**
 * Extended playlist with optional HTTP headers
 */
export interface XtreamPlaylistWithHeaders extends XtreamCredentials {
    id: string;
    name: string;
    type?: string;
    userAgent?: string;
    referrer?: string;
    origin?: string;
}

/**
 * Live stream item with xtream_id
 */
export interface LiveStreamItem {
    xtream_id: number;
    [key: string]: unknown;
}

const XTREAM_CATCHUP_SCHEME = {
    LEGACY: 'legacy',
    REST: 'rest',
} as const;

type XtreamCatchupScheme =
    (typeof XTREAM_CATCHUP_SCHEME)[keyof typeof XTREAM_CATCHUP_SCHEME];

const XTREAM_CATCHUP_VARIANT = {
    LEGACY: 'legacy',
    LEGACY_M3U8: 'legacy:m3u8',
    LEGACY_TS: 'legacy:ts',
    REST_M3U8: 'rest:m3u8',
    REST_TS: 'rest:ts',
} as const;

type XtreamCatchupVariant =
    (typeof XTREAM_CATCHUP_VARIANT)[keyof typeof XTREAM_CATCHUP_VARIANT];

const XTREAM_CATCHUP_EXTENSIONS = {
    M3U8: 'm3u8',
    TS: 'ts',
} as const;

type XtreamCatchupExtension =
    (typeof XTREAM_CATCHUP_EXTENSIONS)[keyof typeof XTREAM_CATCHUP_EXTENSIONS];

interface NormalizedXtreamCredentials {
    password: string;
    rawPassword: string;
    rawUsername: string;
    serverUrl: string;
    username: string;
}

type XtreamProbeApi = {
    xtreamProbeUrl?: (
        url: string,
        method?: 'GET' | 'HEAD'
    ) => Promise<{ status: number }>;
};

interface BrowserIdentity {
    readonly maxTouchPoints?: number;
    readonly platform?: string;
    readonly userAgent?: string;
}

const DEFAULT_PWA_BACKEND_URL = '/api';

/**
 * WebKit on iOS/iPadOS must receive HLS first. Desktop Safari also has the
 * strongest native HLS path. Chromium, Edge and Firefox can use the MPEG-TS
 * web engine, so Auto starts with TS there and retains HLS as its one fallback.
 */
export function prefersTsFirstForWebLive(
    browser: BrowserIdentity | undefined
): boolean {
    const userAgent = browser?.userAgent ?? '';
    const platform = browser?.platform ?? '';
    const isiOS =
        /\b(iPad|iPhone|iPod)\b/i.test(userAgent) ||
        (platform === 'MacIntel' && (browser?.maxTouchPoints ?? 0) > 1);
    if (isiOS) {
        return false;
    }

    const isSafari =
        /Safari/i.test(userAgent) &&
        !/(Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|Firefox|FxiOS)/i.test(
            userAgent
        );
    if (isSafari) {
        return false;
    }

    return /(Chrome|Chromium|CriOS|Edg|EdgiOS|Firefox|FxiOS)/i.test(
        userAgent
    );
}

const XTREAM_CATCHUP_VARIANT_KEY_PREFIX = 'xtream-catchup-variant:v4:';

/**
 * Service for constructing Xtream stream URLs.
 * Handles URL construction for live streams, VOD, and series episodes.
 */
@Injectable({ providedIn: 'root' })
export class XtreamUrlService {
    private readonly databaseService = inject(DatabaseService);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly settingsStore = inject(SettingsStore);
    private readonly catchupSchemeCache = new Map<
        string,
        XtreamCatchupVariant
    >();
    private readonly catchupSchemeRequests = new Map<
        string,
        Promise<XtreamCatchupVariant>
    >();

    /**
     * Construct live stream URL
     * Format: {serverUrl}/live/{username}/{password}/{streamId}.{format}
     */
    constructLiveUrl(
        credentials: XtreamCredentials,
        xtreamId: number,
        format?: string
    ): string {
        const normalizedCredentials = this.normalizeCredentials(credentials);
        if (!normalizedCredentials) {
            return '';
        }

        const streamFormat = this.resolveLiveStreamFormat(
            credentials,
            format ??
                this.settingsStore.streamFormat() ??
                StreamFormat.AutoStreamFormat
        );
        return this.runtime.isPwa
            ? this.constructPwaMediaUrl('live', xtreamId, streamFormat)
            : `${normalizedCredentials.serverUrl}/live/${normalizedCredentials.username}/${normalizedCredentials.password}/${xtreamId}.${streamFormat}`;
    }

    /** No probe: eligibility is explicit account evidence plus the user's Auto intent. */
    constructAutoLiveTsUrl(
        credentials: XtreamCredentials,
        xtreamId: number
    ): string | undefined {
        const requested =
            this.settingsStore.streamFormat() ?? StreamFormat.AutoStreamFormat;
        const formats = this.getNormalizedAllowedOutputFormats(credentials);
        if (
            requested !== StreamFormat.AutoStreamFormat ||
            !formats?.includes('m3u8') ||
            !formats.includes('ts')
        )
            return undefined;
        return (
            this.constructLiveUrl(
                credentials,
                xtreamId,
                StreamFormat.TsStreamFormat
            ) || undefined
        );
    }

    /**
     * The single advertised alternate for Auto mode. It is TS when HLS is the
     * primary source (Safari/Electron) and HLS when TS is primary (Chromium,
     * Edge and Firefox PWA). Manual format choices never advertise a fallback.
     */
    constructAutoLiveFallbackUrl(
        credentials: XtreamCredentials,
        xtreamId: number
    ): string | undefined {
        const requested =
            this.settingsStore.streamFormat() ?? StreamFormat.AutoStreamFormat;
        const formats = this.getNormalizedAllowedOutputFormats(credentials);
        if (
            requested !== StreamFormat.AutoStreamFormat ||
            !formats?.includes(StreamFormat.M3u8StreamFormat) ||
            !formats.includes(StreamFormat.TsStreamFormat)
        ) {
            return undefined;
        }

        const primary = this.resolveAutoLiveStreamFormat(formats);
        const alternate =
            primary === StreamFormat.TsStreamFormat
                ? StreamFormat.M3u8StreamFormat
                : StreamFormat.TsStreamFormat;
        return (
            this.constructLiveUrl(credentials, xtreamId, alternate) ||
            undefined
        );
    }

    /**
     * Construct VOD stream URL
     * Format: {serverUrl}/movie/{username}/{password}/{streamId}.{extension}
     */
    constructVodUrl(
        credentials: XtreamCredentials,
        vodItem: XtreamVodDetails
    ): string {
        const source = resolveXtreamVodPlaybackSource(vodItem);
        if (!source) {
            return '';
        }
        const normalizedCredentials = this.normalizeCredentials(credentials);
        if (!normalizedCredentials) {
            return '';
        }

        return this.runtime.isPwa
            ? this.constructPwaMediaUrl(
                  'movie',
                  source.streamId,
                  source.containerExtension
              )
            : `${normalizedCredentials.serverUrl}/movie/${normalizedCredentials.username}/${normalizedCredentials.password}/${source.streamId}.${source.containerExtension}`;
    }

    /**
     * Construct series episode stream URL
     * Format: {serverUrl}/series/{username}/{password}/{episodeId}.{extension}
     */
    constructEpisodeUrl(
        credentials: XtreamCredentials,
        episode: XtreamSerieEpisode
    ): string {
        const normalizedCredentials = this.normalizeCredentials(credentials);
        if (!normalizedCredentials) {
            return '';
        }

        return this.runtime.isPwa
            ? this.constructPwaMediaUrl(
                  'series',
                  episode.id,
                  episode.container_extension
              )
            : `${normalizedCredentials.serverUrl}/series/${normalizedCredentials.username}/${normalizedCredentials.password}/${episode.id}.${episode.container_extension}`;
    }

    constructCatchupUrl(
        credentials: XtreamCredentials,
        streamId: number,
        startTimestamp: number,
        stopTimestamp: number,
        scheme: XtreamCatchupScheme | XtreamCatchupVariant,
        serverTimezone?: string
    ): string {
        // The secure browser media session currently has no timeshift route.
        // Failing closed avoids ever returning a credential-bearing provider
        // URL to the PWA. Electron keeps its existing direct URL behavior.
        if (this.runtime.isPwa) {
            return '';
        }
        const normalizedCredentials = this.normalizeCredentials(credentials);
        if (!normalizedCredentials) {
            return '';
        }

        const durationMinutes = Math.max(
            1,
            Math.round((stopTimestamp - startTimestamp) / 60)
        );
        const timeString = this.formatCatchupStartTime(
            startTimestamp,
            serverTimezone
        );
        const variant = this.normalizeCatchupVariant(scheme);
        const extension = this.getCatchupVariantExtension(variant);

        if (variant.startsWith(XTREAM_CATCHUP_SCHEME.LEGACY)) {
            const params = new URLSearchParams({
                username: normalizedCredentials.rawUsername,
                password: normalizedCredentials.rawPassword,
                stream: String(streamId),
                start: timeString,
                duration: String(durationMinutes),
            });
            if (extension) {
                params.set('extension', extension);
            }
            return `${normalizedCredentials.serverUrl}/streaming/timeshift.php?${params.toString()}`;
        }

        return `${normalizedCredentials.serverUrl}/timeshift/${normalizedCredentials.username}/${normalizedCredentials.password}/${durationMinutes}/${timeString}/${streamId}.${extension ?? XTREAM_CATCHUP_EXTENSIONS.TS}`;
    }

    async resolveCatchupUrl(
        playlistId: string,
        credentials: XtreamCredentials,
        streamId: number,
        startTimestamp: number,
        stopTimestamp: number,
        serverTimezone?: string
    ): Promise<string> {
        if (this.runtime.isPwa) {
            return '';
        }
        const variant = await this.getCatchupVariant(
            playlistId,
            credentials,
            streamId,
            startTimestamp,
            stopTimestamp,
            serverTimezone
        );

        return this.constructCatchupUrl(
            credentials,
            streamId,
            startTimestamp,
            stopTimestamp,
            variant,
            serverTimezone
        );
    }

    private async getCatchupVariant(
        playlistId: string,
        credentials: XtreamCredentials,
        streamId: number,
        startTimestamp: number,
        stopTimestamp: number,
        serverTimezone?: string
    ): Promise<XtreamCatchupVariant> {
        const cacheKey = this.getCatchupVariantCacheKey(
            playlistId,
            credentials
        );
        const cached = this.catchupSchemeCache.get(cacheKey);
        if (cached) {
            return this.normalizeCatchupVariant(cached);
        }

        const persisted = await this.databaseService.getAppState(cacheKey);
        const persistedVariant = this.parseCatchupVariant(persisted);
        if (persistedVariant) {
            this.catchupSchemeCache.set(cacheKey, persistedVariant);
            return persistedVariant;
        }

        const inFlightRequest = this.catchupSchemeRequests.get(cacheKey);
        if (inFlightRequest) {
            return inFlightRequest;
        }

        const request = this.detectCatchupVariant(
            cacheKey,
            credentials,
            streamId,
            startTimestamp,
            stopTimestamp,
            serverTimezone
        ).finally(() => {
            this.catchupSchemeRequests.delete(cacheKey);
        });

        this.catchupSchemeRequests.set(cacheKey, request);
        return request;
    }

    private async detectCatchupVariant(
        cacheKey: string,
        credentials: XtreamCredentials,
        streamId: number,
        startTimestamp: number,
        stopTimestamp: number,
        serverTimezone?: string
    ): Promise<XtreamCatchupVariant> {
        for (const variant of this.getCatchupVariantCandidates(credentials)) {
            const url = this.constructCatchupUrl(
                credentials,
                streamId,
                startTimestamp,
                stopTimestamp,
                variant,
                serverTimezone
            );
            if (!url) {
                continue;
            }

            const status = await this.probeCatchupUrl(url);
            if (this.isAcceptedCatchupProbeStatus(status)) {
                this.catchupSchemeCache.set(cacheKey, variant);
                await this.databaseService.setAppState(cacheKey, variant);
                return variant;
            }
        }

        this.catchupSchemeCache.set(cacheKey, XTREAM_CATCHUP_VARIANT.REST_TS);
        await this.databaseService.setAppState(
            cacheKey,
            XTREAM_CATCHUP_VARIANT.REST_TS
        );
        return XTREAM_CATCHUP_VARIANT.REST_TS;
    }

    private async probeCatchupUrl(url: string): Promise<number> {
        const probeUrl = (window.electron as XtreamProbeApi | undefined)
            ?.xtreamProbeUrl;

        if (typeof probeUrl !== 'function') {
            return 0;
        }

        try {
            const result = await probeUrl(url, 'GET');
            return Number(result?.status ?? 0);
        } catch {
            return 0;
        }
    }

    private isAcceptedCatchupProbeStatus(status: number): boolean {
        return status === 200 || status === 206;
    }

    private getCatchupVariantCandidates(
        credentials: XtreamCredentials
    ): XtreamCatchupVariant[] {
        const variants: XtreamCatchupVariant[] = [];

        for (const extension of this.getPreferredCatchupExtensions(
            credentials
        )) {
            variants.push(
                extension === XTREAM_CATCHUP_EXTENSIONS.M3U8
                    ? XTREAM_CATCHUP_VARIANT.REST_M3U8
                    : XTREAM_CATCHUP_VARIANT.REST_TS
            );
            variants.push(
                extension === XTREAM_CATCHUP_EXTENSIONS.M3U8
                    ? XTREAM_CATCHUP_VARIANT.LEGACY_M3U8
                    : XTREAM_CATCHUP_VARIANT.LEGACY_TS
            );
        }

        variants.push(XTREAM_CATCHUP_VARIANT.LEGACY);

        return [...new Set(variants)];
    }

    private getPreferredCatchupExtensions(
        credentials: XtreamCredentials
    ): XtreamCatchupExtension[] {
        const allowedFormats =
            this.getNormalizedAllowedOutputFormats(credentials);
        const formats =
            allowedFormats && allowedFormats.length > 0
                ? allowedFormats
                : [
                      XTREAM_CATCHUP_EXTENSIONS.M3U8,
                      XTREAM_CATCHUP_EXTENSIONS.TS,
                  ];

        const preferred = [
            XTREAM_CATCHUP_EXTENSIONS.TS,
            XTREAM_CATCHUP_EXTENSIONS.M3U8,
        ].filter((format) => formats.includes(format));

        return preferred.length > 0
            ? preferred
            : [XTREAM_CATCHUP_EXTENSIONS.TS];
    }

    private getCatchupVariantCacheKey(
        playlistId: string,
        credentials: XtreamCredentials
    ): string {
        const allowedFormats =
            this.getNormalizedAllowedOutputFormats(credentials);
        const formatSignature =
            allowedFormats && allowedFormats.length > 0
                ? [...new Set(allowedFormats)]
                      .sort()
                      .map((format) => encodeURIComponent(format))
                      .join(',')
                : 'unknown';

        return `${XTREAM_CATCHUP_VARIANT_KEY_PREFIX}${playlistId}:formats:${formatSignature}`;
    }

    private getNormalizedAllowedOutputFormats(
        credentials: XtreamCredentials
    ): string[] | undefined {
        const allowedFormats = credentials.allowedOutputFormats
            ?.map((format) => format.trim().toLowerCase())
            .filter(Boolean);

        return allowedFormats && allowedFormats.length > 0
            ? allowedFormats
            : undefined;
    }

    private normalizeCatchupVariant(
        scheme: XtreamCatchupScheme | XtreamCatchupVariant
    ): XtreamCatchupVariant {
        return (
            this.parseCatchupVariant(scheme) ?? XTREAM_CATCHUP_VARIANT.REST_TS
        );
    }

    private parseCatchupVariant(
        value: string | null
    ): XtreamCatchupVariant | null {
        const variants = Object.values(XTREAM_CATCHUP_VARIANT);
        return variants.includes(value as XtreamCatchupVariant)
            ? (value as XtreamCatchupVariant)
            : null;
    }

    private getCatchupVariantExtension(
        variant: XtreamCatchupVariant
    ): XtreamCatchupExtension | null {
        if (
            variant === XTREAM_CATCHUP_VARIANT.REST_M3U8 ||
            variant === XTREAM_CATCHUP_VARIANT.LEGACY_M3U8
        ) {
            return XTREAM_CATCHUP_EXTENSIONS.M3U8;
        }

        if (
            variant === XTREAM_CATCHUP_VARIANT.REST_TS ||
            variant === XTREAM_CATCHUP_VARIANT.LEGACY_TS
        ) {
            return XTREAM_CATCHUP_EXTENSIONS.TS;
        }

        return null;
    }

    private normalizeCredentials(
        credentials: XtreamCredentials
    ): NormalizedXtreamCredentials | null {
        const rawUsername = credentials.username.trim();
        const rawPassword = credentials.password.trim();
        if (!rawUsername || !rawPassword) {
            return null;
        }

        let serverUrl: string;
        try {
            serverUrl = normalizeXtreamServerUrl(credentials.serverUrl);
        } catch {
            return null;
        }

        return {
            password: encodeURIComponent(rawPassword),
            rawPassword,
            rawUsername,
            serverUrl,
            username: encodeURIComponent(rawUsername),
        };
    }

    private resolveLiveStreamFormat(
        credentials: XtreamCredentials,
        requestedFormat: string
    ): string {
        const requested = requestedFormat.trim().toLowerCase();
        const allowedFormats =
            this.getNormalizedAllowedOutputFormats(credentials);

        if (!requested || requested === StreamFormat.AutoStreamFormat) {
            return this.resolveAutoLiveStreamFormat(allowedFormats);
        }

        if (allowedFormats?.length && !allowedFormats.includes(requested)) {
            return allowedFormats[0];
        }

        return requested;
    }

    private resolveAutoLiveStreamFormat(
        allowedFormats: string[] | undefined
    ): string {
        if (!allowedFormats?.length) {
            return StreamFormat.M3u8StreamFormat;
        }

        const supportedPreference =
            this.runtime.isPwa &&
            prefersTsFirstForWebLive(globalThis.navigator)
                ? [StreamFormat.TsStreamFormat, StreamFormat.M3u8StreamFormat]
                : [StreamFormat.M3u8StreamFormat, StreamFormat.TsStreamFormat];
        const preferred = supportedPreference.find((format) =>
            allowedFormats.includes(format)
        );
        if (preferred) return preferred;

        return allowedFormats[0];
    }

    private constructPwaMediaUrl(
        type: 'live' | 'movie' | 'series',
        streamId: number | string,
        extension: string
    ): string {
        const configuredBackendUrl =
            globalThis.window?.__IPTVNATOR_CONFIG__?.BACKEND_URL?.trim() ||
            DEFAULT_PWA_BACKEND_URL;
        const backendUrl = configuredBackendUrl.replace(/\/+$/, '');
        const normalizedExtension = extension
            .trim()
            .replace(/^\.+/, '')
            .toLowerCase();
        return `${backendUrl}/media/${type}/${encodeURIComponent(String(streamId))}.${encodeURIComponent(normalizedExtension)}`;
    }

    /**
     * The panel reads the start segment with `strtotime()` in its own
     * timezone, so the epoch is rendered in the timezone the account info
     * reported (IANA name or clock-derived `UTC±HH:MM`,
     * `xtream-server-timezone.util.ts`). Without one, the viewer's local
     * clock is the only remaining guess.
     */
    private formatCatchupStartTime(
        timestamp: number,
        timezone?: string
    ): string {
        return formatXtreamCatchupStart(timestamp, timezone);
    }
}
