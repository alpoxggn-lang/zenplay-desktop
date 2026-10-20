import type { MediaSession } from './media-session-store';
import {
    RemotePlaybackCapacityError,
    RemotePlaybackTicketStore,
    type RemotePlaybackTicketStoreLimits,
} from './remote-playback-ticket-store';

const LIMITS: RemotePlaybackTicketStoreLimits = {
    globalResources: 4,
    globalTickets: 3,
    resourcesPerSession: 3,
    resourcesPerSource: 3,
    resourcesPerTicket: 3,
    ticketsPerSession: 2,
    ticketsPerSource: 2,
};

describe('RemotePlaybackTicketStore budgets', () => {
    let timestamp = 1_000;

    it('evicts oldest tickets at both session and global budgets', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            LIMITS
        );
        const first = session('first');
        const second = session('second');
        const firstToken = createTicket(store, first, '1');
        timestamp += 1;
        const secondToken = createTicket(store, first, '2');
        timestamp += 1;
        const thirdToken = createTicket(store, first, '3');

        expect(store.get(firstToken)).toBeNull();
        timestamp += 1;
        const otherToken = createTicket(store, second, '4');
        timestamp += 1;
        const newestToken = createTicket(store, second, '5');

        expect(store.get(secondToken)).toBeNull();
        expect(store.get(thirdToken)).not.toBeNull();
        expect(store.get(otherToken)).not.toBeNull();
        expect(store.get(newestToken)).not.toBeNull();
    });

    it('never evicts an active cast when later tickets create pressure', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            LIMITS
        );
        const viewer = session('viewer');
        const active = createTicket(store, viewer, '1');
        expect(store.get(active)).not.toBeNull();
        const idle = createTicket(store, viewer, '2');
        const replacement = createTicket(store, viewer, '3');

        expect(store.get(active)).not.toBeNull();
        expect(store.get(idle)).toBeNull();
        expect(store.get(replacement)).not.toBeNull();
    });

    it('preserves active casts while enforcing the global ticket budget', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            LIMITS
        );
        const active = createTicket(store, session('active'), '1');
        expect(store.get(active)).not.toBeNull();
        const idle = createTicket(store, session('idle'), '2');
        const newer = createTicket(store, session('newer'), '3');
        const latest = createTicket(store, session('latest'), '4');

        expect(store.get(active)).not.toBeNull();
        expect(store.get(idle)).toBeNull();
        expect(store.get(newer)).not.toBeNull();
        expect(store.get(latest)).not.toBeNull();
    });

    it('rejects a new ticket instead of evicting only active casts', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            LIMITS
        );
        const viewer = session('viewer');
        const first = createTicket(store, viewer, '1');
        const second = createTicket(store, viewer, '2');
        expect(store.get(first)).not.toBeNull();
        expect(store.get(second)).not.toBeNull();

        expect(() => createTicket(store, viewer, '3')).toThrow(
            RemotePlaybackCapacityError
        );
        expect(store.get(first)).not.toBeNull();
        expect(store.get(second)).not.toBeNull();
    });

    it('caps one source across many sessions without exhausting global capacity', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            { ...LIMITS, globalTickets: 4 }
        );
        const first = createTicket(store, session('one', 'shared'), '1');
        const second = createTicket(store, session('two', 'shared'), '2');
        expect(store.get(first)).not.toBeNull();
        expect(store.get(second)).not.toBeNull();

        expect(() =>
            createTicket(store, session('three', 'shared'), '3')
        ).toThrow(RemotePlaybackCapacityError);
        const independent = createTicket(
            store,
            session('other', 'independent'),
            '4'
        );

        expect(store.get(first)).not.toBeNull();
        expect(store.get(second)).not.toBeNull();
        expect(store.get(independent)).not.toBeNull();
    });

    it('evicts an inactive same-source ticket before rejecting a new session', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            { ...LIMITS, globalTickets: 4 }
        );
        const oldest = createTicket(store, session('one', 'shared'), '1');
        const active = createTicket(store, session('two', 'shared'), '2');
        expect(store.get(active)).not.toBeNull();

        const replacement = createTicket(
            store,
            session('three', 'shared'),
            '3'
        );

        expect(store.get(oldest)).toBeNull();
        expect(store.get(active)).not.toBeNull();
        expect(store.get(replacement)).not.toBeNull();
    });

    it('releases source capacity after revocation and expiry purge', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            { ...LIMITS, ticketsPerSource: 1 }
        );
        const revoked = session('one', 'shared');
        createTicket(store, revoked, '1');
        store.revokeSession(revoked.id);
        expect(() =>
            createTicket(store, session('two', 'shared'), '2')
        ).not.toThrow();

        timestamp += 1_001;
        store.purgeExpired(timestamp);
        expect(() =>
            createTicket(store, session('three', 'shared'), '3')
        ).not.toThrow();
    });

    it('evicts oldest resources within ticket and session budgets', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            {
                ...LIMITS,
                globalResources: 10,
                resourcesPerSource: 10,
                resourcesPerTicket: 2,
            }
        );
        const firstTicket = createTicket(store, session('first'), '1');
        const secondTicket = createTicket(store, session('first'), '2');
        const first = createResource(store, firstTicket, 'first');
        const second = createResource(store, firstTicket, 'second');
        const third = createResource(store, firstTicket, 'third');
        const fourth = createResource(store, secondTicket, 'fourth');
        const fifth = createResource(store, secondTicket, 'fifth');

        expect(store.getResource(first)).toBeNull();
        expect(store.getResource(second)).toBeNull();
        expect(store.getResource(third)).not.toBeNull();
        expect(store.getResource(fourth)).not.toBeNull();
        expect(store.getResource(fifth)).not.toBeNull();
    });

    it('caps HLS resources across sessions without evicting another source', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            { ...LIMITS, globalResources: 6, resourcesPerSource: 2 }
        );
        const firstTicket = createTicket(store, session('one', 'shared'), '1');
        const secondTicket = createTicket(
            store,
            session('two', 'shared'),
            '2'
        );
        const first = createResource(store, firstTicket, 'first');
        const second = createResource(store, secondTicket, 'second');
        expect(() =>
            createResource(store, secondTicket, 'third')
        ).toThrow(RemotePlaybackCapacityError);

        const independentTicket = createTicket(
            store,
            session('other', 'independent'),
            '3'
        );
        const independent = createResource(
            store,
            independentTicket,
            'independent'
        );
        expect(store.getResource(first)).not.toBeNull();
        expect(store.getResource(second)).not.toBeNull();
        expect(store.getResource(independent)).not.toBeNull();
    });

    it('rejects global resource pressure without cutting active casts', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            { ...LIMITS, globalResources: 2 }
        );
        const firstTicket = createTicket(store, session('one'), '1');
        const secondTicket = createTicket(store, session('two'), '2');
        const thirdTicket = createTicket(store, session('three'), '3');
        const first = createResource(store, firstTicket, 'first');
        const second = createResource(store, secondTicket, 'second');

        expect(() =>
            createResource(store, thirdTicket, 'third')
        ).toThrow(RemotePlaybackCapacityError);
        expect(store.getResource(first)).not.toBeNull();
        expect(store.getResource(second)).not.toBeNull();
    });

    it('releases resource-source capacity after revoke, purge, and clear', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            { ...LIMITS, globalResources: 3, resourcesPerSource: 1 }
        );
        const revoked = session('one', 'shared');
        const revokedTicket = createTicket(store, revoked, '1');
        createResource(store, revokedTicket, 'revoked');
        store.revokeSession(revoked.id);
        const expiringTicket = createTicket(
            store,
            session('two', 'shared'),
            '2'
        );
        createResource(store, expiringTicket, 'expiring');

        timestamp += 4 * 60 * 60 * 1_000 + 1;
        store.purgeExpired(timestamp);
        const clearedTicket = createTicket(
            store,
            session('three', 'shared'),
            '3'
        );
        createResource(store, clearedTicket, 'cleared');
        store.clear();

        const freshTicket = createTicket(
            store,
            session('four', 'shared'),
            '4'
        );
        expect(() => createResource(store, freshTicket, 'fresh')).not.toThrow();
    });

    it('keeps a recently read HLS resource when the ticket budget is full', () => {
        const store = new RemotePlaybackTicketStore(
            () => timestamp,
            1_000,
            LIMITS
        );
        const ticket = createTicket(store, session('viewer'), '1');
        const first = createResource(store, ticket, 'first');
        const second = createResource(store, ticket, 'second');
        const third = createResource(store, ticket, 'third');

        expect(store.getResource(first)).not.toBeNull();
        const fourth = createResource(store, ticket, 'fourth');

        expect(store.getResource(first)).not.toBeNull();
        expect(store.getResource(second)).toBeNull();
        expect(store.getResource(third)).not.toBeNull();
        expect(store.getResource(fourth)).not.toBeNull();
    });
});

function createTicket(
    store: RemotePlaybackTicketStore,
    mediaSession: MediaSession,
    streamId: string
): string {
    return store.create(mediaSession, {
        adaptive: false,
        extension: 'mp4',
        kind: 'movie',
        streamId,
    });
}

function session(id: string, sourceId = `${id}-source`): MediaSession {
    return {
        expiresAt: Number.MAX_SAFE_INTEGER,
        id,
        password: `${id}-password`,
        sourceId,
        targetBaseUrl: `https://${id}.example/`,
        username: `${id}-user`,
    };
}

function createResource(
    store: RemotePlaybackTicketStore,
    ticket: string,
    name: string
): string {
    return (
        store.createResource(
            ticket,
            new URL(`https://provider.example/${name}.ts`)
        ) ?? ''
    );
}
