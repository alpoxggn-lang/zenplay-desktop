import type { Express, Request, RequestHandler, Response } from 'express';
import {
    AdaptiveMediaError,
    type AdaptiveMediaGateway,
    type AdaptiveMediaKind,
} from './adaptive-media-manager';
import {
    readMediaSessionId,
    type MediaSessionStore,
} from './media-session-store';
import { buildXtreamMediaUrl } from './xtream-media-url';

const STREAM_ID = /^\d{1,16}$/;
const ADAPTIVE_FILE =
    /^(?:master|video|audio-\d+|subtitle-\d+)\.m3u8$|^(?:video|audio-\d+)-\d{6}\.ts$|^subtitle-\d+-(?:\d{6}|filler)\.vtt$/;

export interface AdaptiveMediaRouteOptions {
    readonly corsMiddleware: RequestHandler;
    readonly gateway: AdaptiveMediaGateway;
    readonly secureCookie: boolean;
    readonly store: MediaSessionStore;
}

export function mountAdaptiveMediaRoute(
    app: Express,
    options: AdaptiveMediaRouteOptions
): void {
    const path = '/media/adaptive/:kind/:streamId.:extension/:file';
    app.options(path, options.corsMiddleware);
    app.get(path, options.corsMiddleware, async (req, res) => {
        setPrivateResponseHeaders(res);
        const session = options.store.get(
            readMediaSessionId(req.headers.cookie)
        );
        if (!session) {
            res.status(401).json({
                message: 'Media session required',
                status: 401,
            });
            return;
        }
        res.setHeader(
            'Set-Cookie',
            options.store.cookieHeaders(session, options.secureCookie)
        );
        const kind = routeParam(req, 'kind');
        const streamId = routeParam(req, 'streamId');
        const extension = routeParam(req, 'extension').toLowerCase();
        const file = routeParam(req, 'file');
        if (
            !isAdaptiveKind(kind) ||
            !STREAM_ID.test(streamId) ||
            extension !== 'mkv' ||
            !ADAPTIVE_FILE.test(file)
        ) {
            res.status(400).json({
                message: 'Invalid adaptive media path',
                status: 400,
            });
            return;
        }
        try {
            const filePath = await options.gateway.getFile({
                extension,
                file,
                kind,
                session,
                sourceUrl: buildXtreamMediaUrl(
                    session,
                    kind,
                    streamId,
                    extension
                ),
                streamId,
            });
            res.type(contentType(file));
            res.sendFile(filePath, (error) => {
                if (error && !res.headersSent) {
                    res.status(404).json({
                        message: 'Adaptive media file not found',
                        status: 404,
                    });
                }
            });
        } catch (error) {
            if (res.headersSent) return;
            const status =
                error instanceof AdaptiveMediaError ? error.status : 502;
            if (status === 503) res.setHeader('Retry-After', '2');
            res.status(status).json({
                message:
                    status === 503
                        ? 'Adaptive media is not ready'
                        : 'Adaptive media request failed',
                status,
            });
        }
    });
}

function isAdaptiveKind(value: string): value is AdaptiveMediaKind {
    return value === 'movie' || value === 'series';
}

function routeParam(req: Request, key: string): string {
    const value = req.params[key];
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function contentType(file: string): string {
    if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (file.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
    return 'video/mp2t';
}

function setPrivateResponseHeaders(res: Response): void {
    res.setHeader('Cache-Control', 'private, no-store, no-transform');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Surrogate-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
}
