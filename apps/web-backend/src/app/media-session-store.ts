import { randomBytes } from 'node:crypto';

export const MEDIA_SESSION_COOKIE = 'zenplay_media';
/**
 * The browser authenticates the account through `/api/xtream` and consumes
 * the resulting opaque session through `/api/media`. Keep one narrowly scoped
 * cookie shared by both route families.
 */
export const MEDIA_SESSION_COOKIE_PATH = '/api';
const LEGACY_MEDIA_SESSION_COOKIE_PATH = '/api/media';
export const DEFAULT_MEDIA_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_MEDIA_RESOURCE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_RESOURCES_PER_SESSION = 4_096;

export interface MediaSession {
    readonly id: string;
    readonly password: string;
    readonly targetBaseUrl: string;
    readonly username: string;
    readonly expiresAt: number;
}

interface MediaResource {
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly sessionId: string;
    readonly url: string;
}

export interface MediaSessionStoreOptions {
    readonly now?: () => number;
    readonly resourceTtlMs?: number;
    readonly sessionTtlMs?: number;
}

/** Ephemeral credentials and HLS locations; nothing is persisted or exposed. */
export class MediaSessionStore {
    private readonly sessions = new Map<string, MediaSession>();
    /**
     * A backend restart forgets live sessions while the browser still carries
     * its opaque cookie. Several Xtream requests can then arrive concurrently
     * with that same stale id. Remembering its replacement keeps those
     * requests on one session without deduplicating unrelated clients that
     * merely happen to use the same provider credentials.
     */
    private readonly replacementSessionIds = new Map<string, string>();
    private readonly resources = new Map<string, MediaResource>();
    private readonly resourceTokensByUrl = new Map<string, string>();
    private readonly now: () => number;
    private readonly resourceTtlMs: number;
    private readonly sessionTtlMs: number;
    private readonly cleanupTimer: NodeJS.Timeout;

    constructor(options: MediaSessionStoreOptions = {}) {
        this.now = options.now ?? Date.now;
        this.resourceTtlMs =
            options.resourceTtlMs ?? DEFAULT_MEDIA_RESOURCE_TTL_MS;
        this.sessionTtlMs =
            options.sessionTtlMs ?? DEFAULT_MEDIA_SESSION_TTL_MS;
        const cleanupEvery = Math.max(
            1_000,
            Math.min(this.sessionTtlMs, this.resourceTtlMs, 60_000)
        );
        this.cleanupTimer = setInterval(
            () => this.purgeExpired(),
            cleanupEvery
        );
        this.cleanupTimer.unref();
    }

    issue(options: {
        readonly currentSessionId?: string;
        readonly password: string;
        readonly targetBaseUrl: string;
        readonly username: string;
    }): MediaSession {
        this.purgeExpired();
        const hadDirectCurrentSession = options.currentSessionId
            ? this.sessions.has(options.currentSessionId)
            : false;
        const current = this.get(options.currentSessionId);
        const sameIdentity =
            current?.targetBaseUrl === options.targetBaseUrl &&
            current.username === options.username &&
            current.password === options.password;
        if (current && !sameIdentity) this.removeSession(current.id);
        const id = sameIdentity && current ? current.id : opaqueToken(32);
        const session: MediaSession = {
            id,
            password: options.password,
            targetBaseUrl: options.targetBaseUrl,
            username: options.username,
            expiresAt: this.now() + this.sessionTtlMs,
        };
        this.sessions.set(id, session);
        if (
            options.currentSessionId &&
            options.currentSessionId !== id &&
            !hadDirectCurrentSession
        ) {
            this.replacementSessionIds.set(options.currentSessionId, id);
        }
        return session;
    }

    get(sessionId: string | undefined): MediaSession | null {
        if (!sessionId) return null;
        const resolvedSessionId =
            this.replacementSessionIds.get(sessionId) ?? sessionId;
        const session = this.sessions.get(resolvedSessionId);
        if (!session || session.expiresAt <= this.now()) {
            if (session) this.removeSession(resolvedSessionId);
            else this.replacementSessionIds.delete(sessionId);
            return null;
        }
        const refreshed = {
            ...session,
            expiresAt: this.now() + this.sessionTtlMs,
        };
        this.sessions.set(resolvedSessionId, refreshed);
        return refreshed;
    }

    createResource(session: MediaSession, url: URL): string {
        this.purgeExpired();
        const indexKey = resourceIndexKey(session.id, url.href);
        const existingToken = this.resourceTokensByUrl.get(indexKey);
        const existing = existingToken
            ? this.resources.get(existingToken)
            : undefined;
        if (existingToken && existing) {
            this.resources.set(existingToken, {
                ...existing,
                expiresAt: this.now() + this.resourceTtlMs,
            });
            return existingToken;
        }
        this.enforceSessionResourceLimit(session.id);
        const token = opaqueToken(24);
        this.resources.set(token, {
            createdAt: this.now(),
            sessionId: session.id,
            url: url.href,
            expiresAt: this.now() + this.resourceTtlMs,
        });
        this.resourceTokensByUrl.set(indexKey, token);
        return token;
    }

    getResource(sessionId: string, token: string): URL | null {
        const session = this.get(sessionId);
        const resource = this.resources.get(token);
        if (
            !session ||
            !resource ||
            resource.sessionId !== session.id ||
            resource.expiresAt <= this.now()
        ) {
            if (resource?.expiresAt && resource.expiresAt <= this.now()) {
                this.removeResource(token, resource);
            }
            return null;
        }
        this.resources.set(token, {
            ...resource,
            expiresAt: this.now() + this.resourceTtlMs,
        });
        return new URL(resource.url);
    }

    cookieHeader(session: MediaSession, secure = true): string {
        const maxAge = Math.max(
            0,
            Math.floor((session.expiresAt - this.now()) / 1000)
        );
        return [
            `${MEDIA_SESSION_COOKIE}=${session.id}`,
            'HttpOnly',
            'SameSite=Strict',
            `Path=${MEDIA_SESSION_COOKIE_PATH}`,
            `Max-Age=${maxAge}`,
            ...(secure ? ['Secure'] : []),
        ].join('; ');
    }

    cookieHeaders(session: MediaSession, secure = true): readonly string[] {
        return [
            this.cookieHeader(session, secure),
            this.clearCookieAtPath(LEGACY_MEDIA_SESSION_COOKIE_PATH, secure),
        ];
    }

    clearCookieHeader(secure = true): string {
        return this.clearCookieAtPath(MEDIA_SESSION_COOKIE_PATH, secure);
    }

    clearCookieHeaders(secure = true): readonly string[] {
        return [
            this.clearCookieHeader(secure),
            this.clearCookieAtPath(LEGACY_MEDIA_SESSION_COOKIE_PATH, secure),
        ];
    }

    private clearCookieAtPath(path: string, secure: boolean): string {
        return [
            `${MEDIA_SESSION_COOKIE}=`,
            'HttpOnly',
            'SameSite=Strict',
            `Path=${path}`,
            'Max-Age=0',
            ...(secure ? ['Secure'] : []),
        ].join('; ');
    }

    revoke(sessionId: string | undefined): void {
        if (!sessionId) return;
        this.removeSession(
            this.replacementSessionIds.get(sessionId) ?? sessionId
        );
    }

    purgeExpired(): void {
        const timestamp = this.now();
        for (const [id, session] of this.sessions) {
            if (session.expiresAt <= timestamp) this.removeSession(id);
        }
        for (const [token, resource] of this.resources) {
            if (resource.expiresAt <= timestamp)
                this.removeResource(token, resource);
        }
    }

    close(): void {
        clearInterval(this.cleanupTimer);
        this.sessions.clear();
        this.replacementSessionIds.clear();
        this.resources.clear();
        this.resourceTokensByUrl.clear();
    }

    private removeSession(sessionId: string): void {
        this.sessions.delete(sessionId);
        for (const [staleSessionId, replacementSessionId] of this
            .replacementSessionIds) {
            if (
                staleSessionId === sessionId ||
                replacementSessionId === sessionId
            ) {
                this.replacementSessionIds.delete(staleSessionId);
            }
        }
        for (const [token, resource] of this.resources) {
            if (resource.sessionId === sessionId)
                this.removeResource(token, resource);
        }
    }

    private enforceSessionResourceLimit(sessionId: string): void {
        const sessionResources = [...this.resources.entries()]
            .filter(([, resource]) => resource.sessionId === sessionId)
            .sort((left, right) => left[1].createdAt - right[1].createdAt);
        while (sessionResources.length >= MAX_RESOURCES_PER_SESSION) {
            const oldest = sessionResources.shift();
            if (oldest) this.removeResource(oldest[0], oldest[1]);
        }
    }

    private removeResource(token: string, resource: MediaResource): void {
        this.resources.delete(token);
        this.resourceTokensByUrl.delete(
            resourceIndexKey(resource.sessionId, resource.url)
        );
    }
}

export function readMediaSessionId(
    cookieHeader: string | undefined
): string | undefined {
    for (const part of cookieHeader?.split(';') ?? []) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (
            name === MEDIA_SESSION_COOKIE &&
            /^[A-Za-z0-9_-]{32,}$/.test(value)
        ) {
            return value;
        }
    }
    return undefined;
}

function opaqueToken(bytes: number): string {
    return randomBytes(bytes).toString('base64url');
}

function resourceIndexKey(sessionId: string, url: string): string {
    return `${sessionId}\0${url}`;
}
