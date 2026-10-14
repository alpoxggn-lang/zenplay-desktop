import { randomBytes } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import { ValidatedHttpClient } from './validated-http-client';
import {
    adaptiveDirectoryName,
    adaptiveJobKey,
    publishAdaptiveMasterWhenReady,
    refreshAdaptiveSubtitleManifest,
} from './adaptive-media-files';
import {
    AdaptiveProcessSpawner,
    probeAdaptiveSource,
    spawnAdaptiveProcess,
    startAdaptiveFfmpeg,
} from './adaptive-media-process';
import type { MediaSession } from './media-session-store';

const DEFAULT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_FILE_WAIT_MS = 120_000;
const FAILED_JOB_TTL_MS = 5_000;
const MAX_GLOBAL_JOBS = 8;
const MAX_SESSION_JOBS = 2;

export type AdaptiveMediaKind = 'movie' | 'series';

export interface AdaptiveMediaRequest {
    readonly extension: 'mkv';
    readonly file: string;
    readonly kind: AdaptiveMediaKind;
    readonly session: MediaSession;
    readonly sourceUrl: URL;
    readonly streamId: string;
}

export interface AdaptiveMediaGateway {
    getFile(request: AdaptiveMediaRequest): Promise<string>;
    revokeSession(sessionId: string): void;
}

export class AdaptiveMediaError extends Error {
    constructor(
        readonly status: 404 | 502 | 503,
        message: string
    ) {
        super(message);
        this.name = 'AdaptiveMediaError';
    }
}

interface AdaptiveJob {
    readonly directory: string;
    readonly key: string;
    readonly sessionId: string;
    readonly started: Promise<void>;
    expiresAt: number;
    failure?: AdaptiveMediaError;
    process?: ChildProcessWithoutNullStreams;
    source?: Readable;
}

export interface AdaptiveMediaManagerOptions {
    readonly cacheTtlMs?: number;
    readonly ffmpegPath?: string;
    readonly ffprobePath?: string;
    readonly fileWaitMs?: number;
    readonly now?: () => number;
    readonly spawnProcess?: AdaptiveProcessSpawner;
}

export class AdaptiveMediaManager implements AdaptiveMediaGateway {
    private readonly jobs = new Map<string, AdaptiveJob>();
    private readonly root = join(
        tmpdir(),
        `zenplay-adaptive-${randomBytes(12).toString('hex')}`
    );
    private readonly cacheTtlMs: number;
    private readonly fileWaitMs: number;
    private readonly ffmpegPath: string;
    private readonly ffprobePath: string;
    private readonly now: () => number;
    private readonly spawnProcess: AdaptiveProcessSpawner;
    private readonly cleanupTimer: NodeJS.Timeout;

    constructor(
        private readonly client: ValidatedHttpClient,
        options: AdaptiveMediaManagerOptions = {}
    ) {
        this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        this.fileWaitMs = options.fileWaitMs ?? DEFAULT_FILE_WAIT_MS;
        this.ffmpegPath =
            options.ffmpegPath ??
            (process.env['ZENPLAY_FFMPEG_PATH']?.trim() || 'ffmpeg');
        this.ffprobePath =
            options.ffprobePath ??
            (process.env['ZENPLAY_FFPROBE_PATH']?.trim() || 'ffprobe');
        this.now = options.now ?? Date.now;
        this.spawnProcess = options.spawnProcess ?? spawnAdaptiveProcess;
        this.cleanupTimer = setInterval(
            () => this.purgeExpired(),
            Math.max(1_000, Math.min(this.cacheTtlMs, 60_000))
        );
        this.cleanupTimer.unref();
    }

    async getFile(request: AdaptiveMediaRequest): Promise<string> {
        this.purgeExpired();
        const key = adaptiveJobKey(request);
        let job = this.jobs.get(key);
        if (!job) {
            this.enforceLimits(request.session.id);
            const directory = join(this.root, adaptiveDirectoryName(key));
            job = {
                directory,
                key,
                sessionId: request.session.id,
                expiresAt: this.now() + this.cacheTtlMs,
                started: this.startJob(directory, request).catch((error) => {
                    const current = this.jobs.get(key);
                    if (current) {
                        current.failure = normalizeAdaptiveError(error);
                        current.expiresAt = this.now() + FAILED_JOB_TTL_MS;
                    }
                    throw error;
                }),
            };
            this.jobs.set(key, job);
        }
        if (job.failure) throw job.failure;
        job.expiresAt = this.now() + this.cacheTtlMs;
        try {
            await job.started;
            const subtitle = /^subtitle-(\d+)\.m3u8$/u.exec(request.file);
            if (subtitle) {
                const index = Number(subtitle[1]);
                const refreshed = await refreshAdaptiveSubtitleManifest(
                    job.directory,
                    index,
                    { endList: job.process === undefined }
                );
                if (!refreshed) {
                    throw new AdaptiveMediaError(
                        503,
                        'Adaptive subtitles are still being prepared'
                    );
                }
            }
            return await this.waitForFile(job, request.file);
        } catch (error) {
            throw normalizeAdaptiveError(error);
        }
    }

    revokeSession(sessionId: string): void {
        for (const job of this.jobs.values()) {
            if (job.sessionId === sessionId) this.removeJob(job);
        }
    }

    close(): void {
        clearInterval(this.cleanupTimer);
        for (const job of [...this.jobs.values()]) this.removeJob(job);
        void this.safeRemove(this.root).catch(() => undefined);
    }

    private async startJob(
        directory: string,
        request: AdaptiveMediaRequest
    ): Promise<void> {
        await mkdir(directory, { recursive: true });
        const layout = await probeAdaptiveSource({
            binary: this.ffprobePath,
            client: this.client,
            sourceUrl: request.sourceUrl,
            spawnProcess: this.spawnProcess,
        });
        const running = await startAdaptiveFfmpeg({
            binary: this.ffmpegPath,
            client: this.client,
            directory,
            layout,
            sourceUrl: request.sourceUrl,
            spawnProcess: this.spawnProcess,
        });
        const job = this.jobs.get(adaptiveJobKey(request));
        if (!job) {
            running.source.destroy();
            running.child.kill();
            return;
        }
        job.process = running.child;
        job.source = running.source;
        void running.completion.then(
            () => {
                job.process = undefined;
                job.source = undefined;
            },
            (error) => {
                job.process = undefined;
                job.source = undefined;
                job.failure = normalizeAdaptiveError(error);
                job.expiresAt = this.now() + FAILED_JOB_TTL_MS;
            }
        );
        const published = await publishAdaptiveMasterWhenReady(
            directory,
            layout,
            {
                interrupted: () => job.failure !== undefined,
                timeoutMs: this.fileWaitMs,
            }
        );
        if (job.failure) throw job.failure;
        if (!published) {
            throw new AdaptiveMediaError(
                503,
                'Adaptive renditions were not created in time'
            );
        }
    }

    private async waitForFile(job: AdaptiveJob, file: string): Promise<string> {
        const path = join(job.directory, file);
        const deadline = this.now() + this.fileWaitMs;
        while (true) {
            try {
                await access(path);
                return path;
            } catch {
                if (job.failure) throw job.failure;
                if (this.now() >= deadline) {
                    throw new AdaptiveMediaError(
                        503,
                        'Adaptive media is still being prepared'
                    );
                }
                await delay(100);
            }
        }
    }

    private purgeExpired(): void {
        const timestamp = this.now();
        for (const job of [...this.jobs.values()]) {
            if (job.expiresAt <= timestamp) this.removeJob(job);
        }
    }

    private enforceLimits(sessionId: string): void {
        const own = [...this.jobs.values()]
            .filter((job) => job.sessionId === sessionId)
            .sort((a, b) => a.expiresAt - b.expiresAt);
        while (own.length >= MAX_SESSION_JOBS) {
            const oldest = own.shift();
            if (oldest) this.removeJob(oldest);
        }
        const all = [...this.jobs.values()].sort(
            (a, b) => a.expiresAt - b.expiresAt
        );
        while (all.length >= MAX_GLOBAL_JOBS) {
            const oldest = all.shift();
            if (oldest) this.removeJob(oldest);
        }
    }

    private removeJob(job: AdaptiveJob): void {
        if (this.jobs.get(job.key) !== job) return;
        this.jobs.delete(job.key);
        job.source?.destroy();
        job.process?.kill();
        void this.safeRemove(job.directory).catch(() => undefined);
    }

    private async safeRemove(path: string): Promise<void> {
        const root = resolve(this.root);
        const target = resolve(path);
        if (target !== root && !target.startsWith(`${root}${sep}`)) return;
        await rm(target, { force: true, recursive: true });
    }
}

function normalizeAdaptiveError(error: unknown): AdaptiveMediaError {
    if (error instanceof AdaptiveMediaError) return error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return new AdaptiveMediaError(
        code === 'ENOENT' ? 503 : 502,
        code === 'ENOENT'
            ? 'Adaptive media tools are unavailable'
            : 'Adaptive media preparation failed'
    );
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolveDelay) =>
        setTimeout(resolveDelay, milliseconds)
    );
}
