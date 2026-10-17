import { TranslateService } from '@ngx-translate/core';
import { normalizeDateLocale } from '@iptvnator/pipes/date-format';
import { type ZenPlayAccountExpiryAlert } from '@iptvnator/shared/interfaces';
import { firstValueFrom } from 'rxjs';

const EXPIRY_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Formats an expiry alert in the active UI language without shifting its day. */
export interface LocalizedZenPlayExpiryCopy {
    readonly body: string;
    readonly closeLabel: string;
    readonly title: string;
}

export async function loadLocalizedZenPlayExpiryCopy(
    alert: ZenPlayAccountExpiryAlert,
    translate: TranslateService
): Promise<LocalizedZenPlayExpiryCopy | null> {
    const parts = EXPIRY_DATE_PATTERN.exec(alert.expiresOn);
    if (!parts) return null;

    const [, year, month, day] = parts;
    const expiresAt = new Date(
        Date.UTC(Number(year), Number(month) - 1, Number(day))
    );
    if (Number.isNaN(expiresAt.getTime())) return null;

    const language =
        translate.currentLang || translate.getDefaultLang() || 'en';
    const locale = normalizeDateLocale(language);
    let formattedDate: string;
    try {
        formattedDate = new Intl.DateTimeFormat(locale, {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(expiresAt);
    } catch {
        formattedDate = new Intl.DateTimeFormat('en', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(expiresAt);
    }

    const bodyKey =
        alert.kind === 'today'
            ? 'SETTINGS.ACCOUNT_EXPIRY_ALERT_TODAY'
            : 'SETTINGS.ACCOUNT_EXPIRY_ALERT_TOMORROW';
    const titleKey = 'SETTINGS.ACCOUNT_EXPIRY_ALERT_TITLE';
    const closeKey = 'CLOSE';
    const copy = await firstValueFrom(
        translate.get([bodyKey, titleKey, closeKey], { date: formattedDate })
    );
    const body = copy[bodyKey];
    const title = copy[titleKey];
    const closeLabel = copy[closeKey];
    return typeof body === 'string' &&
        typeof title === 'string' &&
        typeof closeLabel === 'string'
        ? { body, closeLabel, title }
        : null;
}
