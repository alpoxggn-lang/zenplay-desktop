const MS_PER_DAY = 86_400_000;

export type ZenPlayAccountExpiryAlertKind = 'tomorrow' | 'today';

export interface ZenPlayAccountExpiryAlert {
    readonly expiresOn: string;
    readonly kind: ZenPlayAccountExpiryAlertKind;
}

/** Optional localized copy is additive so older renderer requests still work. */
export interface ZenPlayAccountExpiryNotificationRequest extends ZenPlayAccountExpiryAlert {
    readonly body?: string;
    readonly title?: string;
}

function localDayOrdinal(date: Date): number {
    return Math.floor(
        Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) /
            MS_PER_DAY
    );
}

function toLocalDateKey(date: Date): string {
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseCalendarDate(value: unknown): Date | null {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));

    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
        ? date
        : null;
}

/**
 * Maps a real Xtream `exp_date` (unix seconds) to the two calendar-day alerts.
 * Calendar ordinals avoid 23/25-hour DST days changing the answer.
 */
export function resolveZenPlayAccountExpiryAlert(
    expiresAtSeconds: number | null | undefined,
    now = new Date()
): ZenPlayAccountExpiryAlert | null {
    if (
        expiresAtSeconds === null ||
        expiresAtSeconds === undefined ||
        !Number.isFinite(expiresAtSeconds) ||
        expiresAtSeconds <= 0 ||
        Number.isNaN(now.getTime())
    ) {
        return null;
    }

    const expiresAt = new Date(expiresAtSeconds * 1000);
    if (Number.isNaN(expiresAt.getTime())) return null;

    const daysUntil = localDayOrdinal(expiresAt) - localDayOrdinal(now);
    const kind =
        daysUntil === 1 ? 'tomorrow' : daysUntil === 0 ? 'today' : null;
    return kind ? { expiresOn: toLocalDateKey(expiresAt), kind } : null;
}

export function isZenPlayAccountExpiryAlert(
    value: unknown
): value is ZenPlayAccountExpiryAlert {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return (
        (candidate['kind'] === 'tomorrow' || candidate['kind'] === 'today') &&
        parseCalendarDate(candidate['expiresOn']) !== null
    );
}

export function formatZenPlayAccountExpiryMessage(
    alert: ZenPlayAccountExpiryAlert
): string | null {
    if (!isZenPlayAccountExpiryAlert(alert)) return null;
    const date = parseCalendarDate(alert.expiresOn);
    if (!date) return null;

    const dateLabel = new Intl.DateTimeFormat('es-MX', {
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC',
        year: 'numeric',
    }).format(date);
    const when = alert.kind === 'today' ? 'hoy' : 'mañana';
    return `Tu cuenta de ZenPlay vence ${when} (${dateLabel}).`;
}

function hashIdentity(value: string, seed: number): string {
    let hash = seed >>> 0;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Opaque, local-only account identity; it never stores raw portal details. */
export function createZenPlayAccountFingerprint(
    playlistId: string,
    serverUrl: string,
    username: string
): string {
    const identity = `${playlistId}\u001f${serverUrl}\u001f${username}`;
    return `account:${hashIdentity(identity, 0x811c9dc5)}${hashIdentity(
        identity,
        0x9e3779b9
    )}`;
}

export function buildZenPlayExpiryAlertDedupeKey(
    accountFingerprint: string,
    alert: ZenPlayAccountExpiryAlert
): string {
    return JSON.stringify([accountFingerprint, alert.expiresOn, alert.kind]);
}
