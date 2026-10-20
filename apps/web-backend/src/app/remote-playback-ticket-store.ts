import { randomBytes } from 'node:crypto';
import type { MediaSession } from './media-session-store';

export const DEFAULT_REMOTE_PLAYBACK_TICKET_TTL_MS = 15 * 60 * 1000;
const MAX_REMOTE_PLAYBACK_TICKET_LIFETIME_MS = 4 * 60 * 60 * 1000;
const DEFAULT_LIMITS: RemotePlaybackTicketStoreLimits = {
    globalResources: 16_384,
    globalTickets: 512,
    resourcesPerSession: 8_192,
    resourcesPerSource: 8_192,
    resourcesPerTicket: 8_192,
    ticketsPerSession: 8,
    ticketsPerSource: 16,
};

export interface RemotePlaybackTicketStoreLimits {
    readonly globalResources: number;
    readonly globalTickets: number;
    readonly resourcesPerSession: number;
    readonly resourcesPerSource: number;
    readonly resourcesPerTicket: number;
    readonly ticketsPerSession: number;
    readonly ticketsPerSource: number;
}

export class RemotePlaybackCapacityError extends Error {
    constructor() {
        super('Remote playback capacity is reserved by active sessions');
        this.name = 'RemotePlaybackCapacityError';
    }
}

export interface RemotePlaybackMediaDescriptor {
    readonly adaptive: boolean;
    readonly extension: string;
    readonly kind: 'live' | 'movie' | 'series';
    readonly streamId: string;
}

export interface RemotePlaybackTicket {
    readonly descriptor: RemotePlaybackMediaDescriptor;
    readonly session: MediaSession;
}

interface StoredRemotePlaybackTicket {
    activated: boolean;
    readonly createdAt: number;
    readonly descriptor: RemotePlaybackMediaDescriptor;
    readonly session: MediaSession;
    expiresAt: number;
}

interface RemotePlaybackResource {
    readonly sessionId: string;
    readonly sourceId: string;
    readonly ticketToken: string;
    readonly url: string;
    expiresAt: number;
}

export interface ResolvedRemotePlaybackResource {
    readonly session: MediaSession;
    readonly ticketToken: string;
    readonly url: URL;
}

export class RemotePlaybackTicketStore {
    private readonly tickets = new Map<string, StoredRemotePlaybackTicket>();
    private readonly resources = new Map<string, RemotePlaybackResource>();
    private readonly resourceTokensByUrl = new Map<string, string>();
    private readonly ticketTokensBySession = new Map<string, Set<string>>();
    private readonly ticketTokensBySource = new Map<string, Set<string>>();
    private readonly resourceTokensByTicket = new Map<string, Set<string>>();
    private readonly resourceTokensBySession = new Map<string, Set<string>>();
    private readonly resourceTokensBySource = new Map<string, Set<string>>();

    constructor(
        private readonly now: () => number,
        private readonly ticketTtlMs: number,
        private readonly limits: RemotePlaybackTicketStoreLimits = DEFAULT_LIMITS
    ) {
        for (const value of Object.values(limits)) {
            if (!Number.isSafeInteger(value) || value < 1) {
                throw new Error('Remote playback limits must be positive');
            }
        }
    }

    /**
     * Issues a short-lived bearer URL for a remote renderer. The token is
     * scoped to one media item and never contains provider credentials.
     */
    create(
        session: MediaSession,
        descriptor: RemotePlaybackMediaDescriptor
    ): string {
        this.purgeExpired(this.now());
        this.assertTicketCapacity(session.id, session.sourceId);
        this.enforceTicketLimit(session.id);
        this.enforceSourceTicketLimit(session.sourceId);
        this.enforceGlobalTicketLimit();
        const token = opaqueToken(24);
        const createdAt = this.now();
        this.tickets.set(token, {
            activated: false,
            createdAt,
            descriptor: { ...descriptor },
            session: { ...session },
            expiresAt: this.expiry(createdAt),
        });
        addToIndex(this.ticketTokensBySession, session.id, token);
        addToIndex(this.ticketTokensBySource, session.sourceId, token);
        return token;
    }

    get(token: string, activate = true): RemotePlaybackTicket | null {
        const stored = this.tickets.get(token);
        if (!stored || stored.expiresAt <= this.now()) {
            if (stored) this.removeTicket(token);
            return null;
        }
        // The short issuance window protects an URL that was never claimed.
        // Once a receiver starts reading it, keep that same URL valid until
        // the hard cap so later MP4 Range requests do not fail mid-playback.
        if (activate && !stored.activated) {
            stored.activated = true;
            stored.expiresAt = this.hardExpiry(stored.createdAt);
        }
        return { descriptor: stored.descriptor, session: stored.session };
    }

    createResource(ticketToken: string, url: URL): string | null {
        const ticket = this.tickets.get(ticketToken);
        if (!ticket || !this.get(ticketToken)) return null;
        const indexKey = resourceIndexKey(ticketToken, url.href);
        const existingToken = this.resourceTokensByUrl.get(indexKey);
        const existing = existingToken
            ? this.resources.get(existingToken)
            : undefined;
        if (existingToken && existing) {
            existing.expiresAt = ticket.expiresAt;
            this.touchResource(existingToken, existing);
            return existingToken;
        }
        this.enforceResourceLimit(ticketToken);
        this.enforceSessionResourceLimit(ticket.session.id);
        this.assertResourceCapacity(ticket.session.sourceId);
        const token = opaqueToken(24);
        this.resources.set(token, {
            sessionId: ticket.session.id,
            sourceId: ticket.session.sourceId,
            ticketToken,
            url: url.href,
            expiresAt: ticket.expiresAt,
        });
        this.resourceTokensByUrl.set(indexKey, token);
        addToIndex(this.resourceTokensByTicket, ticketToken, token);
        addToIndex(this.resourceTokensBySession, ticket.session.id, token);
        addToIndex(this.resourceTokensBySource, ticket.session.sourceId, token);
        return token;
    }

    getResource(token: string): ResolvedRemotePlaybackResource | null {
        const resource = this.resources.get(token);
        if (!resource || resource.expiresAt <= this.now()) {
            if (resource) this.removeResource(token, resource);
            return null;
        }
        const ticket = this.get(resource.ticketToken);
        if (!ticket) {
            this.removeResource(token, resource);
            return null;
        }
        const storedTicket = this.tickets.get(resource.ticketToken);
        if (storedTicket) resource.expiresAt = storedTicket.expiresAt;
        this.touchResource(token, resource);
        return {
            session: ticket.session,
            ticketToken: resource.ticketToken,
            url: new URL(resource.url),
        };
    }

    revokeSession(sessionId: string): void {
        for (const [token, ticket] of this.tickets) {
            if (ticket.session.id === sessionId) this.removeTicket(token);
        }
    }

    revokeTicket(token: string, sessionId: string): boolean {
        const ticket = this.tickets.get(token);
        if (!ticket || ticket.session.id !== sessionId) return false;
        this.removeTicket(token);
        return true;
    }

    purgeExpired(timestamp: number): void {
        for (const [token, ticket] of this.tickets) {
            if (ticket.expiresAt <= timestamp) this.removeTicket(token);
        }
        for (const [token, resource] of this.resources) {
            if (resource.expiresAt <= timestamp) {
                this.removeResource(token, resource);
            }
        }
    }

    clear(): void {
        this.tickets.clear();
        this.resources.clear();
        this.resourceTokensByUrl.clear();
        this.ticketTokensBySession.clear();
        this.ticketTokensBySource.clear();
        this.resourceTokensByTicket.clear();
        this.resourceTokensBySession.clear();
        this.resourceTokensBySource.clear();
    }

    private enforceTicketLimit(sessionId: string): void {
        const tickets = this.ticketTokensBySession.get(sessionId);
        while ((tickets?.size ?? 0) >= this.limits.ticketsPerSession) {
            const oldest = this.firstInactiveTicket(tickets);
            if (!oldest) return;
            this.removeTicket(oldest);
        }
    }

    private enforceSourceTicketLimit(sourceId: string): void {
        const tickets = this.ticketTokensBySource.get(sourceId);
        while ((tickets?.size ?? 0) >= this.limits.ticketsPerSource) {
            const oldest = this.firstInactiveTicket(tickets);
            if (!oldest) return;
            this.removeTicket(oldest);
        }
    }

    private enforceResourceLimit(ticketToken: string): void {
        const resources = this.resourceTokensByTicket.get(ticketToken);
        while ((resources?.size ?? 0) >= this.limits.resourcesPerTicket) {
            const oldest = firstValue(resources);
            if (!oldest) return;
            this.removeResource(oldest, this.resources.get(oldest));
        }
    }

    private enforceGlobalTicketLimit(): void {
        while (this.tickets.size >= this.limits.globalTickets) {
            const oldest = this.firstInactiveTicket(this.tickets.keys());
            if (!oldest) return;
            this.removeTicket(oldest);
        }
    }

    private assertTicketCapacity(sessionId: string, sourceId: string): void {
        const sessionTickets = this.ticketTokensBySession.get(sessionId);
        const sourceTickets = this.ticketTokensBySource.get(sourceId);
        const sessionFull =
            (sessionTickets?.size ?? 0) >= this.limits.ticketsPerSession;
        const sourceFull =
            (sourceTickets?.size ?? 0) >= this.limits.ticketsPerSource;
        const globalFull = this.tickets.size >= this.limits.globalTickets;
        if (
            (sessionFull && !this.firstInactiveTicket(sessionTickets)) ||
            (sourceFull && !this.firstInactiveTicket(sourceTickets)) ||
            (globalFull && !this.firstInactiveTicket(this.tickets.keys()))
        ) {
            throw new RemotePlaybackCapacityError();
        }
    }

    private firstInactiveTicket(
        tokens: Iterable<string> | undefined
    ): string | undefined {
        for (const token of tokens ?? []) {
            if (this.tickets.get(token)?.activated === false) return token;
        }
        return undefined;
    }

    private enforceSessionResourceLimit(sessionId: string): void {
        const resources = this.resourceTokensBySession.get(sessionId);
        while ((resources?.size ?? 0) >= this.limits.resourcesPerSession) {
            const oldest = firstValue(resources);
            if (!oldest) return;
            this.removeResource(oldest, this.resources.get(oldest));
        }
    }

    private assertResourceCapacity(sourceId: string): void {
        if (
            (this.resourceTokensBySource.get(sourceId)?.size ?? 0) >=
                this.limits.resourcesPerSource ||
            this.resources.size >= this.limits.globalResources
        ) {
            throw new RemotePlaybackCapacityError();
        }
    }

    private expiry(createdAt: number): number {
        return Math.min(
            this.now() + this.ticketTtlMs,
            this.hardExpiry(createdAt)
        );
    }

    private hardExpiry(createdAt: number): number {
        return createdAt + MAX_REMOTE_PLAYBACK_TICKET_LIFETIME_MS;
    }

    private removeTicket(token: string): void {
        const ticket = this.tickets.get(token);
        for (const resourceToken of [
            ...(this.resourceTokensByTicket.get(token) ?? []),
        ]) {
            this.removeResource(
                resourceToken,
                this.resources.get(resourceToken)
            );
        }
        this.tickets.delete(token);
        if (ticket) {
            removeFromIndex(
                this.ticketTokensBySession,
                ticket.session.id,
                token
            );
            removeFromIndex(
                this.ticketTokensBySource,
                ticket.session.sourceId,
                token
            );
        }
        this.resourceTokensByTicket.delete(token);
    }

    private removeResource(
        token: string,
        resource: RemotePlaybackResource | undefined
    ): void {
        if (!resource) return;
        this.resources.delete(token);
        this.resourceTokensByUrl.delete(
            resourceIndexKey(resource.ticketToken, resource.url)
        );
        removeFromIndex(
            this.resourceTokensByTicket,
            resource.ticketToken,
            token
        );
        removeFromIndex(
            this.resourceTokensBySession,
            resource.sessionId,
            token
        );
        removeFromIndex(this.resourceTokensBySource, resource.sourceId, token);
    }

    private touchResource(
        token: string,
        resource: RemotePlaybackResource
    ): void {
        this.resources.delete(token);
        this.resources.set(token, resource);
        touchIndex(this.resourceTokensByTicket, resource.ticketToken, token);
        touchIndex(this.resourceTokensBySession, resource.sessionId, token);
        touchIndex(this.resourceTokensBySource, resource.sourceId, token);
    }
}

function opaqueToken(bytes: number): string {
    return randomBytes(bytes).toString('base64url');
}

function resourceIndexKey(ticketToken: string, url: string): string {
    return `${ticketToken}\0${url}`;
}

function addToIndex(
    index: Map<string, Set<string>>,
    key: string,
    token: string
): void {
    const tokens = index.get(key) ?? new Set<string>();
    tokens.add(token);
    index.set(key, tokens);
}

function removeFromIndex(
    index: Map<string, Set<string>>,
    key: string,
    token: string
): void {
    const tokens = index.get(key);
    tokens?.delete(token);
    if (tokens?.size === 0) index.delete(key);
}

function touchIndex(
    index: Map<string, Set<string>>,
    key: string,
    token: string
): void {
    const tokens = index.get(key);
    if (!tokens) return;
    tokens.delete(token);
    tokens.add(token);
}

function firstValue<T>(values: Iterable<T> | undefined): T | undefined {
    return values?.[Symbol.iterator]().next().value;
}
