import type {
    CatchupDownloadMetadata,
    DownloadEpisodeMetadata,
    DownloadMetadataPerson,
    DownloadMetadataSnapshot,
} from '@iptvnator/shared/interfaces';
import type { DownloadItem, DownloadStartInput } from '../downloads.models';
import { resolvePrivateBrowserMediaUrl } from './browser-media-capabilities';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';

interface BrowserDownloadItemContext {
    readonly id: number;
    readonly safeUrl: string;
    readonly fileName: string;
    readonly filePath: string;
    readonly ownerId: string;
    readonly leaseUntil: number;
    readonly createdAt: string;
}

export function sanitizeBrowserPersistedUrl(
    value: string | undefined
): string | undefined {
    const candidate = value?.trim();
    if (!candidate || typeof location === 'undefined') return undefined;
    try {
        const parsed = new URL(candidate, location.origin);
        if (
            parsed.origin !== location.origin ||
            !['http:', 'https:'].includes(parsed.protocol) ||
            parsed.username ||
            parsed.password ||
            parsed.search ||
            parsed.hash
        ) {
            return undefined;
        }
        return parsed.pathname;
    } catch {
        return undefined;
    }
}

const DOWNLOAD_STATUSES = new Set([
    'canceled',
    'completed',
    'downloading',
    'failed',
    'paused',
    'queued',
]);
const CONTENT_TYPES = new Set(['vod', 'episode', 'catchup']);
const FILE_AVAILABILITIES = new Set(['available', 'missing', 'not-applicable']);
const EPISODE_SCOPES = new Set([
    'stalker-embedded-vod',
    'stalker-lazy-vod',
    'stalker-regular-series',
]);
const KNOWN_ERROR_MESSAGES = new Set<string>(
    Object.values(BROWSER_MEDIA_MESSAGES)
);
const PRIVATE_FILE_PATH =
    /^opfs:\/\/zenplay-private-media\/downloads\/[a-z0-9._-]+$/iu;
const PRIVATE_FILE_NAME = /^[a-z0-9._-]+$/iu;
const OPAQUE_ID = /^[a-z0-9_-]{1,256}$/iu;

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : null;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function person(value: unknown): DownloadMetadataPerson | null {
    const source = record(value);
    const name = text(source?.['name']);
    if (!source || !name) return null;
    const profileUrl = sanitizeBrowserPersistedUrl(text(source['profileUrl']));
    const tmdbPersonId = finiteNumber(source['tmdbPersonId']);
    const role = text(source['role']);
    return {
        ...(Number.isSafeInteger(tmdbPersonId) ? { tmdbPersonId } : {}),
        name,
        ...(role ? { role } : {}),
        ...(profileUrl ? { profileUrl } : {}),
    };
}

function episode(value: unknown): DownloadEpisodeMetadata | undefined {
    const source = record(value);
    const seasonNumber = finiteNumber(source?.['seasonNumber']);
    const episodeNumber = finiteNumber(source?.['episodeNumber']);
    if (!source || seasonNumber === undefined || episodeNumber === undefined) {
        return undefined;
    }
    const title = text(source['title']);
    const plot = text(source['plot']);
    const stillUrl = sanitizeBrowserPersistedUrl(text(source['stillUrl']));
    return {
        ...(title ? { title } : {}),
        ...(plot ? { plot } : {}),
        ...(stillUrl ? { stillUrl } : {}),
        seasonNumber,
        episodeNumber,
    };
}

/** Keep useful offline metadata without persisting provider/image hosts or tokens. */
export function sanitizeBrowserDownloadMetadata(
    value: DownloadMetadataSnapshot | undefined
): DownloadMetadataSnapshot | undefined {
    const source = record(value);
    const language = text(source?.['language']);
    const title = text(source?.['title']);
    const mediaKind = source?.['mediaKind'];
    if (
        !source ||
        !language ||
        !title ||
        !['movie', 'series'].includes(String(mediaKind))
    ) {
        return undefined;
    }
    const posterUrl = sanitizeBrowserPersistedUrl(text(source['posterUrl']));
    const backdropUrl = sanitizeBrowserPersistedUrl(
        text(source['backdropUrl'])
    );
    const cast = Array.isArray(source['cast'])
        ? source['cast'].map(person).filter((entry) => entry !== null)
        : undefined;
    const creators = Array.isArray(source['creators'])
        ? source['creators'].map(person).filter((entry) => entry !== null)
        : undefined;
    const episodeMetadata = episode(source['episode']);
    const genres = Array.isArray(source['genres'])
        ? source['genres'].filter(
              (entry): entry is string => typeof entry === 'string'
          )
        : undefined;
    return {
        version: 1,
        language,
        mediaKind: mediaKind as DownloadMetadataSnapshot['mediaKind'],
        title,
        ...(text(source['originalTitle'])
            ? { originalTitle: text(source['originalTitle']) }
            : {}),
        ...(text(source['plot']) ? { plot: text(source['plot']) } : {}),
        ...(text(source['releaseDate'])
            ? { releaseDate: text(source['releaseDate']) }
            : {}),
        ...(finiteNumber(source['year']) === undefined
            ? {}
            : { year: finiteNumber(source['year']) }),
        ...(finiteNumber(source['durationMinutes']) === undefined
            ? {}
            : { durationMinutes: finiteNumber(source['durationMinutes']) }),
        ...(genres ? { genres } : {}),
        ...(finiteNumber(source['rating']) === undefined
            ? {}
            : { rating: finiteNumber(source['rating']) }),
        ...(text(source['status']) ? { status: text(source['status']) } : {}),
        ...(posterUrl ? { posterUrl } : {}),
        ...(backdropUrl ? { backdropUrl } : {}),
        ...(finiteNumber(source['tmdbId']) === undefined
            ? {}
            : { tmdbId: finiteNumber(source['tmdbId']) }),
        ...(text(source['providerCategoryId'])
            ? { providerCategoryId: text(source['providerCategoryId']) }
            : {}),
        ...(cast ? { cast } : {}),
        ...(creators ? { creators } : {}),
        ...(episodeMetadata ? { episode: episodeMetadata } : {}),
        ...(text(source['enrichedAt'])
            ? { enrichedAt: text(source['enrichedAt']) }
            : {}),
    };
}

function sanitizeCatchup(value: unknown): CatchupDownloadMetadata | undefined {
    const source = record(value);
    const channelName = text(source?.['channelName']);
    const startTimestamp = finiteNumber(source?.['startTimestamp']);
    const stopTimestamp = finiteNumber(source?.['stopTimestamp']);
    if (
        !source ||
        !channelName ||
        startTimestamp === undefined ||
        stopTimestamp === undefined
    ) {
        return undefined;
    }
    const expiresAt = finiteNumber(source['expiresAt']);
    return {
        channelName,
        startTimestamp,
        stopTimestamp,
        ...(expiresAt === undefined ? {} : { expiresAt }),
    };
}

/** Rebuilds an existing IndexedDB row, dropping every non-allowlisted field. */
export function sanitizeBrowserDownloadItem(value: DownloadItem): DownloadItem {
    const source = value as DownloadItem & Record<string, unknown>;
    const resolvedUrl = resolvePrivateBrowserMediaUrl(text(source.url) ?? '');
    const url = sanitizeBrowserPersistedUrl(resolvedUrl ?? undefined) ?? '';
    const originalStatus = DOWNLOAD_STATUSES.has(String(source.status))
        ? source.status
        : 'failed';
    const status =
        !url && originalStatus !== 'completed' ? 'failed' : originalStatus;
    const catchup = sanitizeCatchup(source.catchup);
    const fileName = text(source.fileName);
    const filePath = text(source.filePath);
    const posterUrl = sanitizeBrowserPersistedUrl(text(source.posterUrl));
    const metadataSnapshot = sanitizeBrowserDownloadMetadata(
        source.metadataSnapshot
    );
    const errorMessage = !url
        ? BROWSER_MEDIA_MESSAGES.sourceUnsupported
        : KNOWN_ERROR_MESSAGES.has(text(source.errorMessage) ?? '')
          ? text(source.errorMessage)
          : undefined;
    const ownerId = text(source.browserOwnerId);
    const activeOwner =
        !!url &&
        ['queued', 'downloading'].includes(status) &&
        !!ownerId &&
        OPAQUE_ID.test(ownerId);
    return {
        id: source.id,
        playlistId: text(source.playlistId) ?? '',
        xtreamId: finiteNumber(source.xtreamId) ?? 0,
        contentType: CONTENT_TYPES.has(String(source.contentType))
            ? source.contentType
            : 'vod',
        ...(source.catchup === null
            ? { catchup: null }
            : catchup
              ? { catchup }
              : {}),
        ...(finiteNumber(source.seriesXtreamId) === undefined
            ? {}
            : { seriesXtreamId: finiteNumber(source.seriesXtreamId) }),
        ...(finiteNumber(source.seasonNumber) === undefined
            ? {}
            : { seasonNumber: finiteNumber(source.seasonNumber) }),
        ...(finiteNumber(source.episodeNumber) === undefined
            ? {}
            : { episodeNumber: finiteNumber(source.episodeNumber) }),
        ...(EPISODE_SCOPES.has(String(source.episodeIdentityScope))
            ? { episodeIdentityScope: source.episodeIdentityScope }
            : {}),
        title: text(source.title) ?? '',
        url,
        ...(fileName && PRIVATE_FILE_NAME.test(fileName) ? { fileName } : {}),
        ...(filePath && PRIVATE_FILE_PATH.test(filePath) ? { filePath } : {}),
        ...(FILE_AVAILABILITIES.has(String(source.fileAvailability))
            ? { fileAvailability: source.fileAvailability }
            : {}),
        ...(posterUrl ? { posterUrl } : {}),
        ...(metadataSnapshot ? { metadataSnapshot } : {}),
        status,
        ...(finiteNumber(source.bytesDownloaded) === undefined
            ? {}
            : { bytesDownloaded: finiteNumber(source.bytesDownloaded) }),
        ...(finiteNumber(source.totalBytes) === undefined
            ? {}
            : { totalBytes: finiteNumber(source.totalBytes) }),
        ...(text(source.resumeValidator)
            ? { resumeValidator: text(source.resumeValidator) }
            : {}),
        ...(text(source.mediaSourceId) &&
        OPAQUE_ID.test(text(source.mediaSourceId) ?? '')
            ? { mediaSourceId: text(source.mediaSourceId) }
            : {}),
        ...(activeOwner ? { browserOwnerId: ownerId } : {}),
        ...(activeOwner && finiteNumber(source.browserLeaseUntil) !== undefined
            ? { browserLeaseUntil: finiteNumber(source.browserLeaseUntil) }
            : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(text(source.createdAt)
            ? { createdAt: text(source.createdAt) }
            : {}),
        ...(text(source.updatedAt)
            ? { updatedAt: text(source.updatedAt) }
            : {}),
    };
}

/**
 * Build the IndexedDB row from an explicit allowlist. DownloadStartInput also
 * carries native-provider connection fields; spreading it would persist those
 * secrets in a browser profile even though the PWA fetches through an opaque
 * same-origin route.
 */
export function createBrowserDownloadItem(
    input: DownloadStartInput,
    context: BrowserDownloadItemContext
): DownloadItem {
    return {
        id: context.id,
        playlistId: input.playlistId,
        xtreamId: input.xtreamId,
        contentType: input.contentType,
        catchup: input.catchup,
        seriesXtreamId: input.seriesXtreamId,
        seasonNumber: input.seasonNumber,
        episodeNumber: input.episodeNumber,
        episodeIdentityScope: input.episodeIdentityScope,
        title: input.title,
        url: context.safeUrl,
        posterUrl: sanitizeBrowserPersistedUrl(input.posterUrl),
        metadataSnapshot: sanitizeBrowserDownloadMetadata(
            input.metadataSnapshot
        ),
        fileName: context.fileName,
        filePath: context.filePath,
        fileAvailability: 'available',
        status: 'queued',
        bytesDownloaded: 0,
        browserOwnerId: context.ownerId,
        browserLeaseUntil: context.leaseUntil,
        createdAt: context.createdAt,
        updatedAt: context.createdAt,
    };
}
