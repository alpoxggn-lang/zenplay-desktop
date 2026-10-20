import type { RecordingProgramSnapshot } from '@iptvnator/shared/interfaces';
import type { RecordingItem } from '../recordings.models';
import { sanitizeBrowserPersistedUrl } from './browser-download-item';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';

const RECORDING_STATUSES = new Set([
    'recording',
    'completed',
    'interrupted',
    'failed',
]);
const FILE_AVAILABILITIES = new Set([
    'available',
    'missing',
    'not-applicable',
    'unknown',
]);
const SOURCE_TYPES = new Set(['m3u', 'xtream', 'stalker']);
const PRIVATE_FILE_PATH =
    /^opfs:\/\/zenplay-private-media\/recordings\/[a-z0-9._-]+$/iu;
const OPAQUE_ID = /^[a-z0-9_.:-]{1,256}$/iu;
const MIME_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=,._+-]+)*$/iu;
const URL_SHAPED = /^[a-z][a-z0-9+.-]*:\/\//iu;
const URL_EMBEDDED = /[a-z][a-z0-9+.-]*:\/\/\S+/iu;
const CREDENTIAL_TEXT =
    /(?:^|[?&;\s])(?:username|password|user|pass|token|auth)\s*[:=]+\s*\S+/iu;

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : null;
}

function text(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const candidate = value.trim();
    return candidate || undefined;
}

function safeLabel(value: unknown): string | undefined {
    const candidate = text(value);
    return candidate &&
        !URL_SHAPED.test(candidate) &&
        !URL_EMBEDDED.test(candidate) &&
        !CREDENTIAL_TEXT.test(candidate)
        ? candidate
        : undefined;
}

function dateText(value: unknown): string | undefined {
    const candidate = text(value);
    return candidate && Number.isFinite(Date.parse(candidate))
        ? candidate
        : undefined;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function opaqueId(value: unknown): string | undefined {
    const candidate = text(value);
    return candidate && OPAQUE_ID.test(candidate) ? candidate : undefined;
}

function program(value: unknown): RecordingProgramSnapshot | null {
    const source = record(value);
    const title = safeLabel(source?.['title']);
    const start = dateText(source?.['start']);
    const stop = dateText(source?.['stop']);
    if (!source || !title || !start || !stop) return null;
    const description = safeLabel(source['description']);
    return { title, start, stop, ...(description ? { description } : {}) };
}

/** Rebuild an IndexedDB recording row from browser-safe presentation fields. */
export function sanitizeBrowserRecordingItem(
    value: RecordingItem
): RecordingItem {
    const source = value as RecordingItem & Record<string, unknown>;
    const filePath =
        typeof source.filePath === 'string' &&
        PRIVATE_FILE_PATH.test(source.filePath)
            ? source.filePath
            : '';
    const status = RECORDING_STATUSES.has(String(source.status))
        ? source.status
        : 'failed';
    const ownerId = opaqueId(source.browserOwnerId);
    const activeOwner = status === 'recording' ? ownerId : undefined;
    const removalToken = opaqueId(source.browserRemovalToken);
    const programs = Array.isArray(source.programs)
        ? source.programs.map(program).filter((item) => item !== null)
        : undefined;
    const channelLogoUrl = sanitizeBrowserPersistedUrl(
        typeof source.channelLogoUrl === 'string'
            ? source.channelLogoUrl
            : undefined
    );
    const browserMimeType = text(source.browserMimeType);
    const sessionId = opaqueId(source.sessionId);
    const fileSizeBytes = finiteNumber(source.fileSizeBytes);
    const playlistId = opaqueId(source.playlistId);
    const playlistName = safeLabel(source.playlistName);
    const epgChannelId = safeLabel(source.epgChannelId);
    const programTitle = safeLabel(source.programTitle);
    const programDescription = safeLabel(source.programDescription);
    const programStart = dateText(source.programStart);
    const programStop = dateText(source.programStop);
    const errorMessage = safeLabel(source.errorMessage);
    const endedAt = dateText(source.endedAt);
    const createdAt = dateText(source.createdAt);
    const updatedAt = dateText(source.updatedAt);
    const fileAvailability = !filePath
        ? 'missing'
        : FILE_AVAILABILITIES.has(String(source.fileAvailability))
          ? source.fileAvailability
          : 'unknown';
    return {
        id: source.id,
        ...(sessionId ? { sessionId } : {}),
        status: filePath ? status : 'failed',
        filePath,
        ...(fileSizeBytes === undefined
            ? {}
            : { fileSizeBytes: Math.max(0, fileSizeBytes) }),
        channelName:
            safeLabel(source.channelName) ??
            BROWSER_MEDIA_MESSAGES.defaultLiveTv,
        ...(channelLogoUrl ? { channelLogoUrl } : {}),
        ...(playlistId ? { playlistId } : {}),
        ...(playlistName ? { playlistName } : {}),
        ...(SOURCE_TYPES.has(String(source.sourceType))
            ? { sourceType: source.sourceType }
            : {}),
        ...(epgChannelId ? { epgChannelId } : {}),
        ...(programTitle ? { programTitle } : {}),
        ...(programDescription ? { programDescription } : {}),
        ...(programStart ? { programStart } : {}),
        ...(programStop ? { programStop } : {}),
        ...(programs ? { programs } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        startedAt: dateText(source.startedAt) ?? '',
        ...(endedAt ? { endedAt } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        fileAvailability,
        ...(activeOwner ? { browserOwnerId: activeOwner } : {}),
        ...(activeOwner && finiteNumber(source.browserLeaseUntil) !== undefined
            ? { browserLeaseUntil: finiteNumber(source.browserLeaseUntil) }
            : {}),
        ...(removalToken ? { browserRemovalToken: removalToken } : {}),
        ...(removalToken &&
        finiteNumber(source.browserRemovalStartedAt) !== undefined
            ? {
                  browserRemovalStartedAt: finiteNumber(
                      source.browserRemovalStartedAt
                  ),
              }
            : {}),
        ...(browserMimeType && MIME_TYPE.test(browserMimeType)
            ? { browserMimeType }
            : {}),
    };
}
