import {
    MEDIA_SESSION_COOKIE,
    MEDIA_SESSION_COOKIE_PATH,
    MediaSessionStore,
    readMediaSessionId,
} from './media-session-store';

describe('MediaSessionStore', () => {
    let timestamp = 1_000;
    let store: MediaSessionStore;

    beforeEach(() => {
        timestamp = 1_000;
        store = new MediaSessionStore({
            now: () => timestamp,
            resourceTtlMs: 5_000,
            sessionTtlMs: 1_000,
        });
    });

    afterEach(() => store.close());

    it('keeps credentials private behind an opaque, sliding session', () => {
        const issued = store.issue({
            password: 'secret-password',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });

        expect(issued.id).toMatch(/^[A-Za-z0-9_-]{32,}$/);
        expect(issued.id).not.toContain('viewer');
        timestamp = 1_900;
        expect(store.get(issued.id)?.expiresAt).toBe(2_900);
        timestamp = 2_800;
        expect(store.get(issued.id)?.expiresAt).toBe(3_800);
        timestamp = 3_801;
        expect(store.get(issued.id)).toBeNull();
    });

    it('binds opaque HLS resources to their session and renews active tokens', () => {
        const first = store.issue({
            password: 'one',
            targetBaseUrl: 'https://provider.example/',
            username: 'first',
        });
        const second = store.issue({
            password: 'two',
            targetBaseUrl: 'https://provider.example/',
            username: 'second',
        });
        const token = store.createResource(
            first,
            new URL('https://provider.example/live/first/one/segment.ts')
        );

        expect(token).not.toContain('first');
        expect(store.getResource(second.id, token)).toBeNull();
        expect(store.getResource(first.id, token)?.pathname).toContain(
            'segment.ts'
        );
        timestamp = 5_500;
        expect(store.getResource(first.id, token)).toBeNull();
    });

    it('rotates the session and revokes old HLS tokens when credentials change', () => {
        const first = store.issue({
            password: 'one',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        const token = store.createResource(
            first,
            new URL('https://provider.example/segment.ts')
        );
        const replacement = store.issue({
            currentSessionId: first.id,
            password: 'two',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });

        expect(replacement.id).not.toBe(first.id);
        expect(store.get(first.id)).toBeNull();
        expect(store.getResource(replacement.id, token)).toBeNull();
    });

    it('reuses the current session when the account refresh keeps the same identity', () => {
        const first = store.issue({
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        timestamp = 1_500;

        const refreshed = store.issue({
            currentSessionId: first.id,
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });

        expect(refreshed.id).toBe(first.id);
        expect(refreshed.expiresAt).toBe(2_500);
    });

    it('reuses one replacement for concurrent requests carrying the same stale cookie', () => {
        const staleSessionId = 's'.repeat(43);
        const first = store.issue({
            currentSessionId: staleSessionId,
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        const concurrent = store.issue({
            currentSessionId: staleSessionId,
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });

        expect(concurrent.id).toBe(first.id);
        expect(store.get(staleSessionId)?.id).toBe(first.id);
    });

    it('does not merge clients that have different stale cookies', () => {
        const first = store.issue({
            currentSessionId: 'a'.repeat(43),
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        const second = store.issue({
            currentSessionId: 'b'.repeat(43),
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });

        expect(second.id).not.toBe(first.id);
    });

    it('expires a stale-cookie replacement with the underlying session', () => {
        const staleSessionId = 's'.repeat(43);
        const first = store.issue({
            currentSessionId: staleSessionId,
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });

        timestamp = first.expiresAt + 1;
        expect(store.get(staleSessionId)).toBeNull();

        const replacement = store.issue({
            currentSessionId: staleSessionId,
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        expect(replacement.id).not.toBe(first.id);
    });

    it('revokes the replacement when logout still carries the stale cookie', () => {
        const staleSessionId = 's'.repeat(43);
        const replacement = store.issue({
            currentSessionId: staleSessionId,
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });

        store.revoke(staleSessionId);

        expect(store.get(staleSessionId)).toBeNull();
        expect(store.get(replacement.id)).toBeNull();
    });

    it('serializes the required hardened cookie attributes', () => {
        const session = store.issue({
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        const cookie = store.cookieHeader(session);

        expect(cookie).toContain(`${MEDIA_SESSION_COOKIE}=${session.id}`);
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=Strict');
        expect(cookie).toContain(`Path=${MEDIA_SESSION_COOKIE_PATH}`);
        expect(readMediaSessionId(cookie)).toBe(session.id);
    });

    it('expires the old media-only path while issuing the shared API cookie', () => {
        const session = store.issue({
            password: 'secret',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        const [active, legacy] = store.cookieHeaders(session);

        expect(active).toContain(`${MEDIA_SESSION_COOKIE}=${session.id}`);
        expect(active).toContain(`Path=${MEDIA_SESSION_COOKIE_PATH}`);
        expect(active).not.toContain('Max-Age=0');
        expect(legacy).toContain(`${MEDIA_SESSION_COOKIE}=`);
        expect(legacy).toContain('Path=/api/media');
        expect(legacy).toContain('Max-Age=0');
    });

    it('clears the cookie from the same shared API path', () => {
        const [cookie, legacy] = store.clearCookieHeaders();

        expect(cookie).toContain(`${MEDIA_SESSION_COOKIE}=`);
        expect(cookie).toContain(`Path=${MEDIA_SESSION_COOKIE_PATH}`);
        expect(cookie).toContain('Max-Age=0');
        expect(legacy).toContain('Path=/api/media');
        expect(legacy).toContain('Max-Age=0');
    });
});
