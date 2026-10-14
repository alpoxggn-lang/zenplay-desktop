import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type Express } from 'express';

export interface SingleOriginWebAppOptions {
    readonly backend: Express;
    readonly staticDirectory: string;
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
    app.get('/assets/app-config.js', (_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
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
