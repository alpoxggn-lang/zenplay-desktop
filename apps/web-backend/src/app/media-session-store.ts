import { createHmac, randomBytes } from 'node:crypto';
import {
    DEFAULT_REMOTE_PLAYBACK_TICKET_TTL_MS,
    RemotePlaybackTicketStore,
    type RemotePlaybackMediaDescriptor,
    type RemotePlaybackTicket,
    type ResolvedRemotePlaybackResource,
} from './remote-playback-ticket-store';

export {
    DEFAULT_REMOTE_PLAYBACK_TICKET_TTL_MS,
    type RemotePlaybackMediaDescriptor,
    type RemotePlaybackTicket,
} from './remote-playback-ticket-store';

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
const MAX_MEDIA_SESSIONS = 1_024;

export interface MediaSession {
    readonly id: string;
    readonly password: string;
    readonly sourceId: string;
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
    readonly remotePlaybackTicketTtlMs?: number;
    readonly sourceIdentitySecret?: string;
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
    private readonly remotePlayback: RemotePlaybackTicketStore;
    private readonly now: () => number;
    private readonly resourceTtlMs: number;
    private readonly sessionTtlMs: number;
    private readonly sourceIdentitySecret: string | Buffer;
    private readonly cleanupTimer: NodeJS.Timeout;

    constructor(options: MediaSessionStoreOptions = {}) {
        this.now = options.now ?? Date.now;
        this.resourceTtlMs =
            options.resourceTtlMs ?? DEFAULT_MEDIA_RESOURCE_TTL_MS;
        this.sessionTtlMs =
            options.sessionTtlMs ?? DEFAULT_MEDIA_SESSION_TTL_MS;
        this.sourceIdentitySecret =
            options.sourceIdentitySecret ?? randomBytes(32);
        const remotePlaybackTicketTtlMs =
            options.remotePlaybackTicketTtlMs ??
            DEFAULT_REMOTE_PLAYBACK_TICKET_TTL_MS;
        this.remotePlayback = new RemotePlaybackTicketStore(
            this.now,
            remotePlaybackTicketTtlMs
        );
        const cleanupEvery = Math.max(
            1_000,
            Math.min(
                this.sessionTtlMs,
                this.resourceTtlMs,
                remotePlaybackTicketTtlMs,
                60_000
            )
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
        if (!sameIdentity) this.enforceGlobalSessionLimit();
        const session: MediaSession = {
            id,
            password: options.password,
            sourceId: this.createSourceId(
                options.targetBaseUrl,
                options.username
            ),
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
        this.sessions.delete(resolvedSessionId);
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

    /**
     * Issues a short-lived bearer URL for a remote renderer. The token is
     * deliberately scoped to one media item and never contains provider
     * credentials. An unclaimed URL expires quickly; the first receiver read
     * activates it until the hard lifetime so later Range reads stay valid.
     */
    createRemotePlaybackTicket(
        session: MediaSession,
        descriptor: RemotePlaybackMediaDescriptor
    ): string {
        return this.remotePlayback.create(session, descriptor);
    }

    getRemotePlaybackTicket(
        token: string,
        activate = true
    ): RemotePlaybackTicket | null {
        return this.remotePlayback.get(token, activate);
    }

    revokeRemotePlaybackTicket(sessionId: string, token: string): boolean {
        return this.remotePlayback.revokeTicket(token, sessionId);
    }

    createRemotePlaybackResource(ticketToken: string, url: URL): string | null {
        return this.remotePlayback.createResource(ticketToken, url);
    }

    getRemotePlaybackResource(
        token: string
    ): ResolvedRemotePlaybackResource | null {
        return this.remotePlayback.getResource(token);
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
        const resolvedSessionId =
            this.replacementSessionIds.get(sessionId) ?? sessionId;
        this.removeSession(resolvedSessionId);
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
        this.remotePlayback.purgeExpired(timestamp);
    }

    close(): void {
        clearInterval(this.cleanupTimer);
        this.sessions.clear();
        this.replacementSessionIds.clear();
        this.resources.clear();
        this.resourceTokensByUrl.clear();
        this.remotePlayback.clear();
    }

    private removeSession(sessionId: string): void {
        this.sessions.delete(sessionId);
        this.remotePlayback.revokeSession(sessionId);
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

    private createSourceId(targetBaseUrl: string, username: string): string {
        const target = new URL(targetBaseUrl);
        target.hash = '';
        target.password = '';
        target.searchParams.sort();
        target.username = '';
        target.pathname = `${target.pathname.replace(/\/+$/, '')}/`;
        return createHmac('sha256', this.sourceIdentitySecret)
            .update(target.href)
            .update('\0')
            .update(username)
            .digest('base64url');
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

    private enforceGlobalSessionLimit(): void {
        while (this.sessions.size >= MAX_MEDIA_SESSIONS) {
            const oldestSessionId = this.sessions.keys().next().value as
                string | undefined;
            if (!oldestSessionId) return;
            this.removeSession(oldestSessionId);
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
