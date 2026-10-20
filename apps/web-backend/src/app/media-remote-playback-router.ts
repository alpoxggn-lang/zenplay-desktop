import express, {
    type Express,
    type Request,
    type RequestHandler,
    type Response,
} from 'express';
import {
    AdaptiveMediaError,
    type AdaptiveMediaGateway,
    type AdaptiveMediaKind,
} from './adaptive-media-manager';
import type { ValidatedHttpClient } from './validated-http-client';
import {
    type MediaSession,
    type MediaSessionStore,
    type RemotePlaybackMediaDescriptor,
    type RemotePlaybackTicket,
    readMediaSessionId,
} from './media-session-store';
import { buildXtreamMediaUrl } from './xtream-media-url';
import { RemotePlaybackCapacityError } from './remote-playback-ticket-store';

const STREAM_ID = /^\d{1,16}$/;
const REMOTE_PLAYBACK_TOKEN = /^[A-Za-z0-9_-]{24,128}$/;
const ADAPTIVE_FILE =
    /^(?:master|video|audio-\d+|subtitle-\d+)\.m3u8$|^(?:video|audio-\d+)-\d{6}\.ts$|^subtitle-\d+-(?:\d{6}|filler)\.vtt$/;
const LIVE_FORMATS = new Set(['m3u8', 'ts']);
const VOD_EXTENSIONS = new Set([
    'avi',
    'm3u8',
    'm4v',
    'mkv',
    'm2ts',
    'mov',
    'mp4',
    'mpeg',
    'mpg',
    'ts',
    'webm',
]);

export interface RemotePlaybackRouterOptions {
    readonly adaptiveMedia: AdaptiveMediaGateway;
    readonly client: ValidatedHttpClient;
    readonly corsMiddleware: RequestHandler;
    readonly publicBackendUrl: string;
    readonly secureCookie: boolean;
    readonly store: MediaSessionStore;
}

export type RemotePlaybackMediaProxy = (
    req: Request,
    res: Response,
    session: MediaSession,
    url: URL,
    options: RemotePlaybackRouterOptions,
    remotePlayback?: {
        readonly resourcePath: (url: URL) => string | null;
    }
) => Promise<void>;

/**
 * Remote renderers cannot use the browser's HttpOnly media-session cookie.
 * Give them a short-lived, media-scoped bearer URL instead. The URL never
 * contains an Xtream username, password, provider host, or browser session id.
 */
export function mountRemotePlaybackRoutes(
    app: Express,
    options: RemotePlaybackRouterOptions,
    proxyMedia: RemotePlaybackMediaProxy
): void {
    const streamPath = '/media/cast/:token/stream.:extension';
    const adaptivePath = '/media/cast/:token/adaptive/:file';
    const revokePath = '/media/cast/:token';
    const resourceRoute = '/media/cast-resource/:token';

    for (const path of [
        '/media/cast',
        streamPath,
        adaptivePath,
        resourceRoute,
    ]) {
        app.options(path, (_req, res) => {
            setRemotePlaybackCors(res);
            res.status(204).end();
        });
    }
    app.options(revokePath, options.corsMiddleware);

    app.post(
        '/media/cast',
        options.corsMiddleware,
        express.json({ limit: '16kb' }),
        (req, res) => {
            setPrivateResponseHeaders(res);
            const session = requireSession(req, res, options);
            if (!session) return;
            const descriptor = parseRemotePlaybackDescriptor(req.body);
            if (!descriptor) {
                res.status(400).json({
                    message: 'Invalid remote playback request',
                    status: 400,
                });
                return;
            }
            let token: string;
            try {
                token = options.store.createRemotePlaybackTicket(
                    session,
                    descriptor
                );
            } catch (error) {
                if (!(error instanceof RemotePlaybackCapacityError))
                    throw error;
                res.setHeader('Retry-After', '60');
                res.status(429).json({
                    message: 'Too many active remote playbacks',
                    status: 429,
                });
                return;
            }
            res.status(201).json({
                expiresInSeconds: 15 * 60,
                url: remotePlaybackUrl(options, token, descriptor),
            });
        }
    );

    app.delete(revokePath, options.corsMiddleware, (req, res) => {
        setPrivateResponseHeaders(res);
        const session = requireSession(req, res, options);
        if (!session) return;
        const token = routeParam(req, 'token');
        if (REMOTE_PLAYBACK_TOKEN.test(token)) {
            options.store.revokeRemotePlaybackTicket(session.id, token);
        }
        // Deliberately do not reveal whether this session owned the token.
        res.status(204).end();
    });

    app.get(streamPath, async (req, res) => {
        setPrivateResponseHeaders(res);
        setRemotePlaybackCors(res);
        const token = routeParam(req, 'token');
        const extension = routeParam(req, 'extension').toLowerCase();
        const ticket = readRemotePlaybackTicket(req, res, options, false);
        if (!ticket) return;
        const descriptor = ticket.descriptor;
        if (
            descriptor.adaptive ||
            descriptor.extension !== extension ||
            !isAllowedMediaDescriptor(descriptor)
        ) {
            res.status(404).end();
            return;
        }
        const activeTicket = options.store.getRemotePlaybackTicket(token);
        if (!activeTicket) {
            remotePlaybackExpired(res);
            return;
        }
        await proxyMedia(
            req,
            res,
            activeTicket.session,
            buildXtreamMediaUrl(
                activeTicket.session,
                descriptor.kind,
                descriptor.streamId,
                descriptor.extension
            ),
            options,
            {
                resourcePath: (url) => {
                    const resourceToken =
                        options.store.createRemotePlaybackResource(token, url);
                    return resourceToken
                        ? remotePlaybackResourcePath(options, resourceToken)
                        : null;
                },
            }
        );
    });

    app.get(resourceRoute, async (req, res) => {
        setPrivateResponseHeaders(res);
        setRemotePlaybackCors(res);
        const token = routeParam(req, 'token');
        if (!REMOTE_PLAYBACK_TOKEN.test(token)) {
            res.status(404).end();
            return;
        }
        const resource = options.store.getRemotePlaybackResource(token);
        if (!resource) {
            res.status(410).json({
                message: 'Remote playback link expired',
                status: 410,
            });
            return;
        }
        await proxyMedia(req, res, resource.session, resource.url, options, {
            resourcePath: (url) => {
                const nestedToken = options.store.createRemotePlaybackResource(
                    resource.ticketToken,
                    url
                );
                return nestedToken
                    ? remotePlaybackResourcePath(options, nestedToken)
                    : null;
            },
        });
    });

    app.get(adaptivePath, async (req, res) => {
        setPrivateResponseHeaders(res);
        setRemotePlaybackCors(res);
        const token = routeParam(req, 'token');
        const ticket = readRemotePlaybackTicket(req, res, options, false);
        if (!ticket) return;
        const descriptor = ticket.descriptor;
        const file = routeParam(req, 'file');
        if (
            !descriptor.adaptive ||
            descriptor.extension !== 'mkv' ||
            !isAdaptiveKind(descriptor.kind) ||
            !ADAPTIVE_FILE.test(file)
        ) {
            res.status(404).end();
            return;
        }
        const activeTicket = options.store.getRemotePlaybackTicket(token);
        if (!activeTicket) {
            remotePlaybackExpired(res);
            return;
        }
        try {
            const filePath = await options.adaptiveMedia.getFile({
                extension: 'mkv',
                file,
                kind: descriptor.kind,
                session: activeTicket.session,
                sourceUrl: buildXtreamMediaUrl(
                    activeTicket.session,
                    descriptor.kind,
                    descriptor.streamId,
                    descriptor.extension
                ),
                streamId: descriptor.streamId,
            });
            res.type(adaptiveContentType(file));
            res.sendFile(filePath, (error) => {
                if (error && !res.headersSent) res.status(404).end();
            });
        } catch (error) {
            if (res.headersSent) return;
            const status =
                error instanceof AdaptiveMediaError ? error.status : 502;
            if (status === 503) res.setHeader('Retry-After', '2');
            res.status(status).json({
                message: 'Remote adaptive media request failed',
                status,
            });
        }
    });
}

function requireSession(
    req: Request,
    res: Response,
    options: RemotePlaybackRouterOptions
): MediaSession | null {
    const session = options.store.get(readMediaSessionId(req.headers.cookie));
    if (!session) {
        res.status(401).json({
            message: 'Media session required',
            status: 401,
        });
        return null;
    }
    res.setHeader(
        'Set-Cookie',
        options.store.cookieHeaders(session, options.secureCookie)
    );
    return session;
}

function parseRemotePlaybackDescriptor(
    body: unknown
): RemotePlaybackMediaDescriptor | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const candidate = body as Record<string, unknown>;
    const kind = candidate['kind'];
    if (kind !== 'live' && kind !== 'movie' && kind !== 'series') return null;
    const descriptor: RemotePlaybackMediaDescriptor = {
        adaptive: candidate['adaptive'] === true,
        extension:
            typeof candidate['extension'] === 'string'
                ? candidate['extension'].trim().toLowerCase()
                : '',
        kind,
        streamId:
            typeof candidate['streamId'] === 'string'
                ? candidate['streamId'].trim()
                : '',
    };
    return isAllowedMediaDescriptor(descriptor) ? descriptor : null;
}

function isAllowedMediaDescriptor(
    descriptor: RemotePlaybackMediaDescriptor
): boolean {
    if (!STREAM_ID.test(descriptor.streamId)) return false;
    if (descriptor.adaptive) {
        return (
            descriptor.extension === 'mkv' && isAdaptiveKind(descriptor.kind)
        );
    }
    return descriptor.kind === 'live'
        ? LIVE_FORMATS.has(descriptor.extension)
        : VOD_EXTENSIONS.has(descriptor.extension);
}

function readRemotePlaybackTicket(
    req: Request,
    res: Response,
    options: RemotePlaybackRouterOptions,
    activate = true
): RemotePlaybackTicket | null {
    const token = routeParam(req, 'token');
    if (!REMOTE_PLAYBACK_TOKEN.test(token)) {
        res.status(404).end();
        return null;
    }
    const ticket = options.store.getRemotePlaybackTicket(token, activate);
    if (!ticket) {
        remotePlaybackExpired(res);
        return null;
    }
    return ticket;
}

function remotePlaybackExpired(res: Response): void {
    res.status(410).json({
        message: 'Remote playback link expired',
        status: 410,
    });
}

function remotePlaybackUrl(
    options: RemotePlaybackRouterOptions,
    token: string,
    descriptor: RemotePlaybackMediaDescriptor
): string {
    const suffix = descriptor.adaptive
        ? `/media/cast/${token}/adaptive/master.m3u8`
        : `/media/cast/${token}/stream.${descriptor.extension}`;
    const base = options.publicBackendUrl.replace(/\/+$/, '');
    if (/^https?:\/\//i.test(base)) return `${base}${suffix}`;
    if (!base) return suffix;
    return `${base.startsWith('/') ? '' : '/'}${base}${suffix}`;
}

function remotePlaybackResourcePath(
    options: RemotePlaybackRouterOptions,
    token: string
): string {
    const base = options.publicBackendUrl.replace(/\/+$/, '');
    return `${base}/media/cast-resource/${token}`;
}

function setRemotePlaybackCors(res: Response): void {
    // The scoped bearer token is the credential. Cast/AirPlay receivers do
    // not share the sender's cookie or origin, so only this route family is
    // intentionally readable cross-origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range');
    res.setHeader(
        'Access-Control-Expose-Headers',
        'Accept-Ranges, Content-Length, Content-Range, Content-Type'
    );
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function setPrivateResponseHeaders(res: Response): void {
    res.setHeader('Cache-Control', 'private, no-store, no-transform');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Surrogate-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
}

function routeParam(req: Request, key: string): string {
    const value = req.params[key];
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function isAdaptiveKind(value: string): value is AdaptiveMediaKind {
    return value === 'movie' || value === 'series';
}

function adaptiveContentType(file: string): string {
    if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (file.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
    return 'video/mp2t';
}
