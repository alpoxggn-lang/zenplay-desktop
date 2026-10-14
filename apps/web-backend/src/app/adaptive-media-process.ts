import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import { ValidatedHttpClient } from './validated-http-client';
import {
    AdaptiveMediaLayout,
    buildAdaptiveFfmpegArgs,
    parseAdaptiveMediaProbe,
} from './adaptive-media-layout';

const MEDIA_TIMEOUT_MS = 30_000;
const MAX_PROBE_BYTES = 2 * 1024 * 1024;

export interface AdaptiveProcessSpawner {
    (
        command: string,
        args: readonly string[],
        options: { readonly cwd?: string }
    ): ChildProcessWithoutNullStreams;
}

export interface RunningAdaptiveProcess {
    readonly child: ChildProcessWithoutNullStreams;
    readonly completion: Promise<void>;
    readonly source: Readable;
}

export const spawnAdaptiveProcess: AdaptiveProcessSpawner = (
    command,
    args,
    options
) =>
    spawn(command, [...args], {
        cwd: options.cwd,
        stdio: 'pipe',
        windowsHide: true,
    });

export async function probeAdaptiveSource(options: {
    readonly binary: string;
    readonly client: ValidatedHttpClient;
    readonly sourceUrl: URL;
    readonly spawnProcess: AdaptiveProcessSpawner;
}): Promise<AdaptiveMediaLayout> {
    const controller = new AbortController();
    const response = await options.client.getStream(options.sourceUrl.href, {
        headers: { 'Accept-Encoding': 'identity' },
        signal: controller.signal,
        timeout: MEDIA_TIMEOUT_MS,
    });
    const child = options.spawnProcess(
        options.binary,
        [
            '-v',
            'error',
            '-probesize',
            '12M',
            '-analyzeduration',
            '12000000',
            '-show_streams',
            '-show_entries',
            'stream=index,codec_type,codec_name,profile,pix_fmt,bits_per_raw_sample,width,height,bit_rate:stream_tags=language,title',
            '-of',
            'json',
            'pipe:0',
        ],
        {}
    );
    child.stderr.resume();
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let outputExceeded = false;
    child.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.from(chunk);
        byteCount += buffer.length;
        if (byteCount > MAX_PROBE_BYTES) {
            outputExceeded = true;
            child.kill();
            return;
        }
        chunks.push(buffer);
    });
    const completion = processCompletion(child);
    pipeProviderSource(response.data, child);
    try {
        await completion;
    } finally {
        controller.abort();
        response.data.destroy();
    }
    if (outputExceeded) throw new Error('Media probe output was too large');
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new Error('Media probe returned invalid data');
    }
    return parseAdaptiveMediaProbe(parsed);
}

export async function startAdaptiveFfmpeg(options: {
    readonly binary: string;
    readonly client: ValidatedHttpClient;
    readonly directory: string;
    readonly layout: AdaptiveMediaLayout;
    readonly sourceUrl: URL;
    readonly spawnProcess: AdaptiveProcessSpawner;
}): Promise<RunningAdaptiveProcess> {
    const response = await options.client.getStream(options.sourceUrl.href, {
        headers: { 'Accept-Encoding': 'identity' },
        timeout: MEDIA_TIMEOUT_MS,
    });
    let child: ChildProcessWithoutNullStreams;
    try {
        child = options.spawnProcess(
            options.binary,
            buildAdaptiveFfmpegArgs(options.layout),
            { cwd: options.directory }
        );
        const completion = processCompletion(child);
        // A missing executable rejects both lifecycle promises. Mark the
        // completion as observed while startup reports the actionable error.
        void completion.catch(() => undefined);
        await processStarted(child);
        child.stdout.resume();
        child.stderr.resume();
        pipeProviderSource(response.data, child);
        return {
            child,
            source: response.data,
            completion: completion.finally(() => {
                response.data.destroy();
            }),
        };
    } catch (error) {
        response.data.destroy();
        throw error;
    }
}

function pipeProviderSource(
    source: Readable,
    child: ChildProcessWithoutNullStreams
): void {
    source.once('error', () => {
        child.stdin.destroy();
        child.kill();
    });
    child.stdin.once('error', () => source.destroy());
    source.pipe(child.stdin);
}

function processStarted(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
        const onSpawn = () => {
            child.removeListener('error', onError);
            resolve();
        };
        const onError = (error: Error) => {
            child.removeListener('spawn', onSpawn);
            reject(error);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
    });
}

function processCompletion(
    child: ChildProcessWithoutNullStreams
): Promise<void> {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
            if (code === 0) resolve();
            else
                reject(
                    new Error(
                        `Media process stopped (${code ?? signal ?? 'unknown'})`
                    )
                );
        });
    });
}
