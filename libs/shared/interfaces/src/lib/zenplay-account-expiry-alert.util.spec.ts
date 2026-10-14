import {
    buildZenPlayExpiryAlertDedupeKey,
    createZenPlayAccountFingerprint,
    formatZenPlayAccountExpiryMessage,
    isZenPlayAccountExpiryAlert,
    resolveZenPlayAccountExpiryAlert,
} from './zenplay-account-expiry-alert.util';

function unixSeconds(date: Date): number {
    return date.getTime() / 1000;
}

describe('ZenPlay account expiry alerts', () => {
    const now = new Date(2026, 9, 14, 18, 30);

    it('uses local calendar days for the day-before and expiry-day alerts', () => {
        expect(
            resolveZenPlayAccountExpiryAlert(
                unixSeconds(new Date(2026, 9, 15, 23, 59)),
                now
            )
        ).toEqual({ kind: 'tomorrow', expiresOn: '2026-10-15' });

        expect(
            resolveZenPlayAccountExpiryAlert(
                unixSeconds(new Date(2026, 9, 14, 0, 1)),
                now
            )
        ).toEqual({ kind: 'today', expiresOn: '2026-10-14' });
    });

    it('ignores unlimited, invalid, past-day, and later expirations', () => {
        expect(resolveZenPlayAccountExpiryAlert(null, now)).toBeNull();
        expect(resolveZenPlayAccountExpiryAlert(0, now)).toBeNull();
        expect(resolveZenPlayAccountExpiryAlert(Number.NaN, now)).toBeNull();
        expect(
            resolveZenPlayAccountExpiryAlert(
                unixSeconds(new Date(2026, 9, 13, 23, 59)),
                now
            )
        ).toBeNull();
        expect(
            resolveZenPlayAccountExpiryAlert(
                unixSeconds(new Date(2026, 9, 16, 0, 1)),
                now
            )
        ).toBeNull();
    });

    it('validates calendar dates and produces Spanish ZenPlay copy', () => {
        const alert = { kind: 'today', expiresOn: '2026-10-14' } as const;

        expect(isZenPlayAccountExpiryAlert(alert)).toBe(true);
        expect(
            isZenPlayAccountExpiryAlert({ ...alert, expiresOn: '2026-02-30' })
        ).toBe(false);
        expect(formatZenPlayAccountExpiryMessage(alert)).toContain(
            'Tu cuenta de ZenPlay vence hoy'
        );
        expect(formatZenPlayAccountExpiryMessage(alert)).toContain(
            '14 de octubre de 2026'
        );
    });

    it('deduplicates with an opaque account fingerprint, date, and alert kind', () => {
        const fingerprint = createZenPlayAccountFingerprint(
            'zenplay-primary',
            'https://portal.example.test',
            'cliente@example.test'
        );
        const tomorrow = { kind: 'tomorrow', expiresOn: '2026-10-15' } as const;

        expect(fingerprint).toMatch(/^account:[0-9a-f]{16}$/);
        expect(fingerprint).not.toContain('cliente');
        expect(fingerprint).not.toContain('portal.example.test');
        expect(
            buildZenPlayExpiryAlertDedupeKey(fingerprint, tomorrow)
        ).not.toBe(
            buildZenPlayExpiryAlertDedupeKey(fingerprint, {
                ...tomorrow,
                kind: 'today',
            })
        );
    });
});
