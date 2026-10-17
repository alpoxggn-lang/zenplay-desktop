interface PwaSearchSession<T> {
    readonly value: Promise<T>;
    lastAccessedAt: number;
    settled: boolean;
}

const DEFAULT_SESSION_LIMIT = 6;
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Keeps subsequent pages on the same result snapshot while bounding memory.
 * A new first-page request refreshes a settled snapshot so recovered sources
 * can take part in the next user-initiated search.
 */
export class PwaGlobalSearchSessionCache<T> {
    private readonly sessions = new Map<string, PwaSearchSession<T>>();

    constructor(
        private readonly limit = DEFAULT_SESSION_LIMIT,
        private readonly ttlMs = DEFAULT_SESSION_TTL_MS
    ) {}

    get(
        key: string,
        startsNewSearch: boolean,
        load: () => Promise<T>
    ): Promise<T> {
        const now = Date.now();
        this.prune(now);
        const current = this.sessions.get(key);

        if (current && (!startsNewSearch || !current.settled)) {
            current.lastAccessedAt = now;
            this.touch(key, current);
            return current.value;
        }

        const session: PwaSearchSession<T> = {
            value: Promise.resolve().then(load),
            lastAccessedAt: now,
            settled: false,
        };
        this.sessions.set(key, session);
        this.trim();

        session.value.then(
            () => {
                session.settled = true;
            },
            () => {
                if (this.sessions.get(key) === session) {
                    this.sessions.delete(key);
                }
            }
        );
        return session.value;
    }

    clear(): void {
        this.sessions.clear();
    }

    private prune(now: number): void {
        for (const [key, session] of this.sessions) {
            if (session.settled && now - session.lastAccessedAt > this.ttlMs) {
                this.sessions.delete(key);
            }
        }
    }

    private touch(key: string, session: PwaSearchSession<T>): void {
        this.sessions.delete(key);
        this.sessions.set(key, session);
    }

    private trim(): void {
        while (this.sessions.size > Math.max(1, this.limit)) {
            const oldestKey = this.sessions.keys().next().value as
                string | undefined;
            if (!oldestKey) return;
            this.sessions.delete(oldestKey);
        }
    }
}
import {
    foldSearchText,
    GlobalSearchContentType,
} from '@iptvnator/shared/interfaces';

export function createPwaGlobalSearchSessionKey(
    term: string,
    types: GlobalSearchContentType[],
    excludeHidden: boolean,
    parentalLockVersion: number
): string {
    return JSON.stringify([
        foldSearchText(term),
        [...types].sort(),
        excludeHidden,
        parentalLockVersion,
    ]);
}
