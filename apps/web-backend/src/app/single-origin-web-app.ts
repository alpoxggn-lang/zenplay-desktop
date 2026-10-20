import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type Express } from 'express';

export interface SingleOriginWebAppOptions {
    readonly backend: Express;
    readonly staticDirectory: string;
    readonly trustProxyHops?: number;
}

/** Serves the production PWA and its backend from one HTTPS-ready origin. */
export function createSingleOriginWebApp(
    options: SingleOriginWebAppOptions
): Express {
    const staticDirectory = resolve(options.staticDirectory);
    const indexPath = resolve(staticDirectory, 'index.html');
    if (!existsSync(indexPath)) {
        throw new Error(
            'ZENPLAY_STATIC_DIR must contain a built PWA index.html file'
        );
    }

    const app = express();
    app.disable('x-powered-by');
    const trustProxyHops =
        options.trustProxyHops ?? getConfiguredTrustProxyHops();
    if (trustProxyHops > 0) {
        app.set('trust proxy', trustProxyHops);
    }
    app.use((_req, res, next) => {
        res.set({
            'Content-Security-Policy': "frame-ancestors 'none'",
            'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
        });
        next();
    });
    app.use('/api', options.backend);
    app.use('/api', (_req, res) => {
        res.status(404).json({ message: 'API route not found', status: 404 });
    });

    app.get(
        ['/index.html', '/ngsw.json', '/ngsw-worker.js'],
        (_req, res, next) => {
            res.set('Cache-Control', 'no-cache');
            next();
        }
    );
    app.get('/assets/app-config.js', (_req, res) => {
        res.set('Cache-Control', 'no-store').redirect(307, '/api/config.js');
    });
    app.use(express.static(staticDirectory, { index: false }));

    app.use((req, res, next) => {
        if (req.method !== 'GET' || !req.accepts('html')) {
            next();
            return;
        }
        res.set('Cache-Control', 'no-cache').sendFile(indexPath);
    });

    return app;
}

function getConfiguredTrustProxyHops(): number {
    const value = process.env['ZENPLAY_TRUST_PROXY_HOPS']?.trim();
    if (!value || !/^\d+$/.test(value)) {
        return 0;
    }
    const hops = Number(value);
    return Number.isSafeInteger(hops) ? hops : 0;
}
