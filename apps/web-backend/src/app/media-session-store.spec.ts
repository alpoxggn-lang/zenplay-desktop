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
            remotePlaybackTicketTtlMs: 500,
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

    it('scopes remote playback tickets to one item without exposing credentials', () => {
        const session = store.issue({
            password: 'secret-password',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        const token = store.createRemotePlaybackTicket(session, {
            adaptive: false,
            extension: 'm3u8',
            kind: 'live',
            streamId: '42',
        });

        expect(token).toMatch(/^[A-Za-z0-9_-]{24,}$/);
        expect(token).not.toContain('viewer');
        expect(token).not.toContain('secret-password');
        expect(store.getRemotePlaybackTicket(token)).toEqual({
            descriptor: {
                adaptive: false,
                extension: 'm3u8',
                kind: 'live',
                streamId: '42',
            },
            session: expect.objectContaining({ id: session.id }),
        });
    });

    it('expires a remote playback URL that no receiver claims', () => {
        const session = store.issue({
            password: 'secret-password',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        const ticket = store.createRemotePlaybackTicket(session, {
            adaptive: false,
            extension: 'mp4',
            kind: 'movie',
            streamId: '42',
        });

        timestamp = 1_501;
        expect(store.getRemotePlaybackTicket(ticket)).toBeNull();
    });

    it('keeps active remote resources through the issuance TTL and enforces the hard cap', () => {
        const session = store.issue({
            password: 'secret-password',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        const ticket = store.createRemotePlaybackTicket(session, {
            adaptive: false,
            extension: 'm3u8',
            kind: 'movie',
            streamId: '9',
        });
        const resource = store.createRemotePlaybackResource(
            ticket,
            new URL(
                'https://provider.example/movie/viewer/secret-password/segment.ts'
            )
        );

        expect(resource).toMatch(/^[A-Za-z0-9_-]{24,}$/);
        expect(resource).not.toContain('secret-password');
        timestamp = 1_400;
        expect(
            store.getRemotePlaybackResource(resource ?? '')?.url.pathname
        ).toContain('segment.ts');
        timestamp = 1_901;
        expect(store.getRemotePlaybackResource(resource ?? '')).not.toBeNull();
        timestamp = 4 * 60 * 60 * 1_000 + 1_001;
        expect(store.getRemotePlaybackResource(resource ?? '')).toBeNull();
    });

    it('revokes the previous account cast when the browser authenticates another account', () => {
        const first = store.issue({
            password: 'first-password',
            targetBaseUrl: 'https://first.example/',
            username: 'first-user',
        });
        const ticket = store.createRemotePlaybackTicket(first, {
            adaptive: false,
            extension: 'mp4',
            kind: 'movie',
            streamId: '12',
        });

        store.issue({
            currentSessionId: first.id,
            password: 'second-password',
            targetBaseUrl: 'https://second.example/',
            username: 'second-user',
        });

        expect(store.getRemotePlaybackTicket(ticket)).toBeNull();
    });

    it('derives a stable opaque source identity without using the password', () => {
        const first = store.issue({
            password: 'one',
            targetBaseUrl: 'https://Provider.Example/base',
            username: 'viewer',
        });
        const sameSource = store.issue({
            password: 'two',
            targetBaseUrl: 'https://provider.example/base/',
            username: 'viewer',
        });
        const otherUser = store.issue({
            password: 'one',
            targetBaseUrl: 'https://provider.example/base/',
            username: 'other',
        });
        const otherServer = store.issue({
            password: 'one',
            targetBaseUrl: 'https://other.example/base/',
            username: 'viewer',
        });
        const otherTenant = store.issue({
            password: 'one',
            targetBaseUrl: 'https://provider.example/base/?tenant=two',
            username: 'viewer',
        });

        expect(first.sourceId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(sameSource.sourceId).toBe(first.sourceId);
        expect(otherUser.sourceId).not.toBe(first.sourceId);
        expect(otherServer.sourceId).not.toBe(first.sourceId);
        expect(otherTenant.sourceId).not.toBe(first.sourceId);
        expect(first.sourceId).not.toContain('viewer');
    });

    it('revokes remote playback tickets and resources with their media session', () => {
        const session = store.issue({
            password: 'secret-password',
            targetBaseUrl: 'https://provider.example/',
            username: 'viewer',
        });
        const ticket = store.createRemotePlaybackTicket(session, {
            adaptive: false,
            extension: 'mp4',
            kind: 'series',
            streamId: '12',
        });
        const resource = store.createRemotePlaybackResource(
            ticket,
            new URL('https://provider.example/segment.ts')
        );

        store.revoke(session.id);

        expect(store.getRemotePlaybackTicket(ticket)).toBeNull();
        expect(store.getRemotePlaybackResource(resource ?? '')).toBeNull();
    });

    it('allows only the owning media session to revoke one cast ticket', () => {
        const owner = store.issue({
            password: 'owner-password',
            targetBaseUrl: 'https://provider.example/',
            username: 'owner',
        });
        const other = store.issue({
            password: 'other-password',
            targetBaseUrl: 'https://provider.example/',
            username: 'other',
        });
        const ticket = store.createRemotePlaybackTicket(owner, {
            adaptive: false,
            extension: 'mp4',
            kind: 'movie',
            streamId: '12',
        });

        expect(store.revokeRemotePlaybackTicket(other.id, ticket)).toBe(false);
        expect(store.getRemotePlaybackTicket(ticket, false)).not.toBeNull();
        expect(store.revokeRemotePlaybackTicket(owner.id, ticket)).toBe(true);
        expect(store.getRemotePlaybackTicket(ticket)).toBeNull();
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

    it('evicts the least recently used session at the global budget', () => {
        const sessions = Array.from({ length: 1_025 }, (_, index) =>
            store.issue({
                password: `password-${index}`,
                targetBaseUrl: 'https://provider.example/',
                username: `viewer-${index}`,
            })
        );

        expect(store.get(sessions[0].id)).toBeNull();
        expect(store.get(sessions.at(-1)?.id)).not.toBeNull();
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
