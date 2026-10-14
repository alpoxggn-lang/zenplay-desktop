import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    buildAdaptiveMasterManifest,
    type AdaptiveMediaLayout,
} from './adaptive-media-layout';

export function adaptiveJobKey(request: {
    readonly extension: string;
    readonly kind: string;
    readonly session: { readonly id: string };
    readonly streamId: string;
}): string {
    return [
        request.session.id,
        request.kind,
        request.streamId,
        request.extension,
    ].join(':');
}

export function adaptiveDirectoryName(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 40);
}

export async function writeAdaptiveMaster(
    directory: string,
    layout: AdaptiveMediaLayout
): Promise<void> {
    const temporary = join(directory, 'master.m3u8.tmp');
    const target = join(directory, 'master.m3u8');
    await writeFile(temporary, buildAdaptiveMasterManifest(layout), 'utf8');
    await rename(temporary, target);
}

export async function refreshAdaptiveSubtitleManifest(
    directory: string,
    index: number,
    options: { readonly endList?: boolean } = {}
): Promise<boolean> {
    if (!Number.isSafeInteger(index) || index < 0) return false;
    let source = '';
    try {
        source = await readFile(
            join(directory, `subtitle-${index}.csv`),
            'utf8'
        );
    } catch {
        // FFmpeg creates the CSV only after the first real subtitle cue.
        // Publish an empty WebVTT rendition meanwhile so sparse or empty
        // subtitle tracks cannot hold video/audio playback at the loading UI.
    }
    const segments = parseSubtitleSegments(source, index);
    if (source.trim() && !segments.length) return false;
    const playlistSegments = segments.length
        ? await buildSubtitleTimeline(directory, index, segments)
        : await buildEmptySubtitleTimeline(directory, index);
    if (!playlistSegments.length) return false;
    const durations = playlistSegments.map((segment) => segment.duration);
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-ALLOW-CACHE:NO',
        `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(...durations)))}`,
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
    ];
    playlistSegments.forEach((segment) => {
        lines.push(`#EXTINF:${segment.duration.toFixed(6)},`, segment.file);
    });
    if (options.endList) lines.push('#EXT-X-ENDLIST');
    const contents = `${lines.join('\n')}\n`;
    const target = join(directory, `subtitle-${index}.m3u8`);
    try {
        if ((await readFile(target, 'utf8')) === contents) return true;
    } catch {
        // The first refresh creates the public playlist.
    }
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        await writeFile(temporary, contents, 'utf8');
        await rename(temporary, target);
        return true;
    } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

export async function publishAdaptiveMasterWhenReady(
    directory: string,
    layout: AdaptiveMediaLayout,
    options: {
        readonly interrupted?: () => boolean;
        readonly pollMs?: number;
        readonly timeoutMs: number;
    }
): Promise<boolean> {
    const deadline = Date.now() + options.timeoutMs;
    while (!options.interrupted?.()) {
        if (await renditionsReady(directory, layout)) {
            await writeAdaptiveMaster(directory, layout);
            return true;
        }
        if (Date.now() >= deadline) return false;
        await delay(options.pollMs ?? 100);
    }
    return false;
}

async function renditionsReady(
    directory: string,
    layout: AdaptiveMediaLayout
): Promise<boolean> {
    for (const [index] of layout.subtitles.entries()) {
        if (!(await refreshAdaptiveSubtitleManifest(directory, index))) {
            return false;
        }
    }
    const playlists = [
        'video.m3u8',
        ...layout.audio.map((_track, index) => `audio-${index}.m3u8`),
        ...layout.subtitles.map((_track, index) => `subtitle-${index}.m3u8`),
    ];
    for (const playlist of playlists) {
        if (!(await firstSegmentReady(directory, playlist))) return false;
    }
    return true;
}

interface SubtitleSegment {
    readonly end: number;
    readonly file: string;
    readonly start: number;
}

interface SubtitlePlaylistSegment {
    readonly duration: number;
    readonly file: string;
}

const SUBTITLE_WINDOW_SECONDS = 6;

async function buildEmptySubtitleTimeline(
    directory: string,
    subtitleIndex: number
): Promise<SubtitlePlaylistSegment[]> {
    const filler = await ensureSubtitleFiller(directory, subtitleIndex);
    return [
        {
            duration: SUBTITLE_WINDOW_SECONDS,
            file: `${filler}?window=0`,
        },
    ];
}

async function buildSubtitleTimeline(
    directory: string,
    subtitleIndex: number,
    segments: readonly SubtitleSegment[]
): Promise<SubtitlePlaylistSegment[]> {
    const filler = await ensureSubtitleFiller(directory, subtitleIndex);
    const playlist: SubtitlePlaylistSegment[] = [];
    let cursor = 0;
    let window = 0;

    for (const segment of segments) {
        let contents: string;
        try {
            contents = await readFile(join(directory, segment.file), 'utf8');
        } catch {
            return [];
        }
        const bounds = webVttCueBounds(contents);
        if (!bounds) return [];
        while (bounds.start - cursor > 0.0005) {
            const duration = Math.min(
                SUBTITLE_WINDOW_SECONDS,
                bounds.start - cursor
            );
            playlist.push({
                duration,
                file: `${filler}?window=${window++}`,
            });
            cursor += duration;
        }
        cursor = Math.max(cursor, bounds.start);
        while (bounds.end - cursor > 0.0005) {
            const duration = Math.min(
                SUBTITLE_WINDOW_SECONDS,
                bounds.end - cursor
            );
            playlist.push({
                duration,
                file: `${segment.file}?window=${window++}`,
            });
            cursor += duration;
        }
    }
    return playlist;
}

async function ensureSubtitleFiller(
    directory: string,
    subtitleIndex: number
): Promise<string> {
    const filler = `subtitle-${subtitleIndex}-filler.vtt`;
    try {
        await writeFile(join(directory, filler), 'WEBVTT\n\n', {
            flag: 'wx',
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return filler;
}

function webVttCueBounds(
    contents: string
): { readonly end: number; readonly start: number } | null {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const line of contents.split(/\r?\n/u)) {
        const match =
            /^\s*((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})(?:\s|$)/u.exec(
                line
            );
        if (!match) continue;
        const cueStart = webVttTimestamp(match[1]);
        const cueEnd = webVttTimestamp(match[2]);
        if (
            !Number.isFinite(cueStart) ||
            !Number.isFinite(cueEnd) ||
            cueStart < 0 ||
            cueEnd <= cueStart
        ) {
            return null;
        }
        start = Math.min(start, cueStart);
        end = Math.max(end, cueEnd);
    }
    return Number.isFinite(start) && Number.isFinite(end)
        ? { end, start }
        : null;
}

function webVttTimestamp(value: string): number {
    const parts = value.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) {
        return parts[0] * 3_600 + parts[1] * 60 + parts[2];
    }
    return Number.NaN;
}

function parseSubtitleSegments(
    contents: string,
    subtitleIndex: number
): SubtitleSegment[] {
    const lines = contents.split(/\r?\n/u);
    const filePattern = new RegExp(
        `^subtitle-${subtitleIndex}-\\d{6}\\.vtt$`,
        'u'
    );
    const segments: SubtitleSegment[] = [];
    for (const [lineIndex, rawLine] of lines.entries()) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = /^(?:"([^"]+)"|([^,]+)),([^,]+),([^,]+)$/u.exec(line);
        if (!match) {
            // FFmpeg can be observed between writes. Ignore only a partial
            // final CSV row and retry on the next playlist request.
            if (lineIndex === lines.length - 1) break;
            return [];
        }
        const file = (match[1] ?? match[2] ?? '').trim();
        const start = Number(match[3]);
        const end = Number(match[4]);
        const previous = segments.at(-1);
        if (
            !filePattern.test(file) ||
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start < 0 ||
            end <= start ||
            (previous !== undefined && start <= previous.start)
        ) {
            return [];
        }
        segments.push({ end, file, start });
    }
    return segments;
}

async function firstSegmentReady(
    directory: string,
    playlist: string
): Promise<boolean> {
    try {
        const contents = await readFile(join(directory, playlist), 'utf8');
        const lines = contents.split(/\r?\n/u);
        const extinf = lines.findIndex((line) => line.startsWith('#EXTINF:'));
        const segment = lines
            .slice(extinf + 1)
            .find((line) => line.length > 0 && !line.startsWith('#'));
        const segmentFile = segment?.split('?', 1)[0];
        if (extinf < 0 || !segmentFile || !/^[\w.-]+$/u.test(segmentFile)) {
            return false;
        }
        const details = await stat(join(directory, segmentFile));
        return details.isFile() && details.size > 0;
    } catch {
        return false;
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolveDelay) =>
        setTimeout(resolveDelay, milliseconds)
    );
}
