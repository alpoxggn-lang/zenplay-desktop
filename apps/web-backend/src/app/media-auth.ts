import type { Request, Response } from 'express';
import {
    normalizeXtreamServerUrl,
    resolveXtreamPortalStatus,
} from '@iptvnator/shared/interfaces';
import { MediaSessionStore, readMediaSessionId } from './media-session-store';
import { isZenPlayProviderTargetAllowed } from './zenplay-provider-target-policy';

export function establishMediaSession(options: {
    readonly configuredZenPlayUrl: string | null | undefined;
    readonly params: Record<string, string>;
    readonly now: Date;
    readonly providerPayload: unknown;
    readonly registeredUrl: URL;
    readonly req: Request;
    readonly res: Response;
    readonly secureCookie: boolean;
    readonly store: MediaSessionStore;
}): void {
    if (
        options.req.method !== 'POST' ||
        !options.configuredZenPlayUrl?.trim() ||
        !isZenPlayProviderTargetAllowed(
            options.configuredZenPlayUrl,
            options.registeredUrl.href
        ) ||
        resolveXtreamPortalStatus(
            options.providerPayload as Parameters<
                typeof resolveXtreamPortalStatus
            >[0],
            options.now
        ) !== 'active'
    ) {
        return;
    }

    const username = options.params['username'];
    const password = options.params['password'];
    if (!username || !password) return;

    const session = options.store.issue({
        currentSessionId: readMediaSessionId(options.req.headers.cookie),
        password,
        targetBaseUrl: normalizeXtreamServerUrl(options.registeredUrl.href),
        username,
    });
    options.res.setHeader(
        'Set-Cookie',
        options.store.cookieHeaders(session, options.secureCookie)
    );
}

export function redactCredentialFields(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return payload;
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
        if (key.toLowerCase() === 'password') continue;
        result[key] = Array.isArray(value)
            ? value.map(redactCredentialFields)
            : redactCredentialFields(value);
    }
    return result;
}
