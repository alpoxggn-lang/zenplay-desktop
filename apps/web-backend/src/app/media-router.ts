import type { Express, Request, RequestHandler, Response } from 'express';
import type { Readable } from 'node:stream';
import type { AdaptiveMediaGateway } from './adaptive-media-manager';
import { mountAdaptiveMediaRoute } from './adaptive-media-route';
import { mountRemotePlaybackRoutes } from './media-remote-playback-router';
import { RemotePlaybackCapacityError } from './remote-playback-ticket-store';
import { ProviderRequestError } from './provider-request-error';
import { ValidatedHttpClient } from './validated-http-client';
import {
    isHlsManifest,
    MAX_HLS_MANIFEST_BYTES,
    rewriteHlsManifest,
} from './media-manifest';
import {
    MediaSession,
    MediaSessionStore,
    readMediaSessionId,
} from './media-session-store';
import { buildXtreamMediaUrl } from './xtream-media-url';

const MEDIA_TIMEOUT_MS = 30_000;
const STREAM_ID = /^\d{1,16}$/;
const RESOURCE_TOKEN = /^[A-Za-z0-9_-]{24,128}$/;
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
export const MEDIA_SOURCE_HEADER = 'X-ZenPlay-Media-Source';
export const EXPECTED_MEDIA_SOURCE_HEADER = 'X-ZenPlay-Expected-Media-Source';

export interface MediaRouterOptions {
    readonly adaptiveMedia: AdaptiveMediaGateway;
    readonly client: ValidatedHttpClient;
    readonly corsMiddleware: RequestHandler;
    readonly publicBackendUrl: string;
    readonly secureCookie: boolean;
    readonly store: MediaSessionStore;
}

export function mountMediaRouter(
    app: Express,
    options: MediaRouterOptions
): void {
    mountAdaptiveMediaRoute(app, {
        corsMiddleware: options.corsMiddleware,
        gateway: options.adaptiveMedia,
        secureCookie: options.secureCookie,
        store: options.store,
    });
    mountRemotePlaybackRoutes(app, options, proxyMedia);
    const route =
        (kind: 'live' | 'movie' | 'series') =>
        async (req: Request, res: Response) => {
            setPrivateResponseHeaders(res);
            const session = requireSession(req, res, options);
            if (!session) return;
            const streamId = routeParam(req, 'streamId');
            const extension = routeParam(
                req,
                kind === 'live' ? 'format' : 'extension'
            ).toLowerCase();
            const allowed =
                kind === 'live'
                    ? LIVE_FORMATS.has(extension)
                    : VOD_EXTENSIONS.has(extension);
            if (!streamId || !STREAM_ID.test(streamId) || !allowed) {
                res.status(400).json({
                    message: 'Invalid media path',
                    status: 400,
                });
                return;
            }
            const url = buildXtreamMediaUrl(session, kind, streamId, extension);
            await proxyMedia(req, res, session, url, options);
        };

    app.options('/media/live/:streamId.:format', options.corsMiddleware);
    app.options('/media/movie/:streamId.:extension', options.corsMiddleware);
    app.options('/media/series/:streamId.:extension', options.corsMiddleware);
    app.options('/media/resource/:token', options.corsMiddleware);
    app.options('/media/source', options.corsMiddleware);
    app.options('/media/session', options.corsMiddleware);
    app.get('/media/source', options.corsMiddleware, (req, res) => {
        setPrivateResponseHeaders(res);
        const session = requireSession(req, res, options);
        if (!session) return;
        exposeMediaSource(res, session);
        res.status(204).end();
    });
    app.delete('/media/session', options.corsMiddleware, (req, res) => {
        setPrivateResponseHeaders(res);
        const sessionId = readMediaSessionId(req.headers.cookie);
        options.adaptiveMedia.revokeSession(sessionId ?? '');
        options.store.revoke(sessionId);
        res.setHeader(
            'Set-Cookie',
            options.store.clearCookieHeaders(options.secureCookie)
        );
        res.status(204).end();
    });
    app.get(
        '/media/live/:streamId.:format',
        options.corsMiddleware,
        route('live')
    );
    app.get(
        '/media/movie/:streamId.:extension',
        options.corsMiddleware,
        route('movie')
    );
    app.get(
        '/media/series/:streamId.:extension',
        options.corsMiddleware,
        route('series')
    );
    app.get(
        '/media/resource/:token',
        options.corsMiddleware,
        async (req, res) => {
            setPrivateResponseHeaders(res);
            const sessionId = readMediaSessionId(req.headers.cookie);
            const token = routeParam(req, 'token');
            if (!sessionId || !token || !RESOURCE_TOKEN.test(token)) {
                unauthorized(res);
                return;
            }
            const url = options.store.getResource(sessionId, token);
            const session = options.store.get(sessionId);
            if (!url || !session) {
                unauthorized(res);
                return;
            }
            res.setHeader(
                'Set-Cookie',
                options.store.cookieHeaders(session, options.secureCookie)
            );
            await proxyMedia(req, res, session, url, options);
        }
    );
}

function requireSession(
    req: Request,
    res: Response,
    options: MediaRouterOptions
): MediaSession | null {
    const session = options.store.get(readMediaSessionId(req.headers.cookie));
    if (!session) {
        unauthorized(res);
        return null;
    }
    res.setHeader(
        'Set-Cookie',
        options.store.cookieHeaders(session, options.secureCookie)
    );
    return session;
}

function unauthorized(res: Response): void {
    res.status(401).json({ message: 'Media session required', status: 401 });
}

async function proxyMedia(
    req: Request,
    res: Response,
    session: MediaSession,
    url: URL,
    options: MediaRouterOptions,
    remotePlayback?: {
        readonly resourcePath: (url: URL) => string | null;
    }
): Promise<void> {
    if (!remotePlayback) {
        exposeMediaSource(res, session);
        const expectedSource =
            req.headers[EXPECTED_MEDIA_SOURCE_HEADER.toLowerCase()];
        if (
            expectedSource !== undefined &&
            (Array.isArray(expectedSource) ||
                expectedSource !== session.sourceId)
        ) {
            res.status(409).json({
                message: 'Media source changed',
                status: 409,
            });
            return;
        }
    }
    const range = normalizeRange(req.headers.range);
    if (req.headers.range && !range) {
        res.status(416).end();
        return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    let upstream: Readable | undefined;
    try {
        const ifRange = normalizeIfRange(req.headers['if-range']);
        const response = await options.client.getStream(url.href, {
            acceptedStatuses: [416],
            headers: {
                'Accept-Encoding': 'identity',
                ...(range ? { Range: range } : {}),
                ...(ifRange ? { 'If-Range': ifRange } : {}),
                ...(req.headers['user-agent']
                    ? { 'User-Agent': req.headers['user-agent'] }
                    : {}),
            },
            signal: controller.signal,
            timeout: MEDIA_TIMEOUT_MS,
        });
        upstream = response.data;
        const contentType = response.headers['content-type'];
        const finalUrl = response.finalUrl ? new URL(response.finalUrl) : url;
        if (
            isHlsManifest(contentType, finalUrl) ||
            isHlsManifest(contentType, url)
        ) {
            const manifest = await readManifest(upstream);
            const body = rewriteHlsManifest({
                body: manifest,
                manifestUrl: finalUrl,
                resourcePath: (resourceUrl) =>
                    remotePlayback?.resourcePath(resourceUrl) ??
                    resourcePath(
                        options,
                        options.store.createResource(session, resourceUrl)
                    ),
            });
            res.status(response.status);
            res.type('application/vnd.apple.mpegurl');
            res.send(body);
            return;
        }
        copyMediaHeaders(res, response.headers);
        res.status(response.status);
        upstream.once('error', () => {
            if (!res.destroyed) res.destroy();
        });
        res.once('close', () => upstream?.destroy());
        upstream.pipe(res);
    } catch (error) {
        upstream?.destroy();
        if (controller.signal.aborted || res.headersSent) return;
        const status = mediaErrorStatus(error);
        if (status === 429) res.setHeader('Retry-After', '60');
        res.status(status).json({ message: 'Media request failed', status });
    } finally {
        req.removeListener('aborted', abort);
        if (res.writableEnded) res.removeListener('close', abort);
    }
}

function exposeMediaSource(res: Response, session: MediaSession): void {
    res.setHeader(MEDIA_SOURCE_HEADER, session.sourceId);
    res.setHeader('Access-Control-Expose-Headers', MEDIA_SOURCE_HEADER);
}

function resourcePath(options: MediaRouterOptions, token: string): string {
    const base = options.publicBackendUrl.replace(/\/+$/, '');
    return `${base}/media/resource/${token}`;
}

function normalizeRange(value: string | undefined): string | undefined {
    if (!value || value.length > 128) return undefined;
    const match = /^bytes=(.+)$/.exec(value);
    if (!match) return undefined;
    const ranges = match[1].split(',').map((range) => range.trim());
    if (ranges.length > 8) return undefined;
    for (const range of ranges) {
        const suffix = /^-(\d+)$/.exec(range);
        if (suffix) {
            if (Number(suffix[1]) <= 0) return undefined;
            continue;
        }
        const bounded = /^(\d+)-(\d*)$/.exec(range);
        if (!bounded) return undefined;
        if (bounded[2] && Number(bounded[1]) > Number(bounded[2])) {
            return undefined;
        }
    }
    return `bytes=${ranges.join(',')}`;
}

function normalizeIfRange(
    value: string | string[] | undefined
): string | undefined {
    if (Array.isArray(value)) value = value[0];
    if (!value || value.length > 256 || /[\r\n]/.test(value)) return undefined;
    return value;
}

function routeParam(req: Request, key: string): string {
    const value = req.params[key];
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

async function readManifest(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_HLS_MANIFEST_BYTES) {
            stream.destroy();
            throw new Error('HLS manifest exceeds the configured limit');
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function copyMediaHeaders(
    res: Response,
    headers: Readonly<Record<string, string | undefined>>
): void {
    for (const name of [
        'accept-ranges',
        'content-length',
        'content-range',
        'content-type',
        'etag',
        'last-modified',
    ]) {
        const value = headers[name];
        if (value) res.setHeader(name, value);
    }
}

function setPrivateResponseHeaders(res: Response): void {
    res.setHeader('Cache-Control', 'private, no-store, no-transform');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Surrogate-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
}

function mediaErrorStatus(error: unknown): number {
    if (error instanceof RemotePlaybackCapacityError) return 429;
    const cause = error instanceof ProviderRequestError ? error.cause : error;
    const status = (cause as { response?: { status?: unknown } } | null)
        ?.response?.status;
    return typeof status === 'number' && status >= 400 && status <= 599
        ? status
        : 502;
}
