export interface AdaptiveMediaStream {
    readonly index: number;
    readonly codecName: string;
    readonly kind: 'audio' | 'subtitle' | 'video';
    readonly language: string;
    readonly title: string;
    readonly bitsPerRawSample?: number;
    readonly width?: number;
    readonly height?: number;
    readonly bitRate?: number;
    readonly pixelFormat?: string;
    readonly profile?: string;
}

export interface AdaptiveMediaLayout {
    readonly audio: readonly AdaptiveMediaStream[];
    readonly subtitles: readonly AdaptiveMediaStream[];
    readonly video: AdaptiveMediaStream;
}

interface ProbeStream {
    readonly index?: unknown;
    readonly codec_name?: unknown;
    readonly codec_type?: unknown;
    readonly width?: unknown;
    readonly height?: unknown;
    readonly bit_rate?: unknown;
    readonly bits_per_raw_sample?: unknown;
    readonly pix_fmt?: unknown;
    readonly profile?: unknown;
    readonly tags?: Readonly<Record<string, unknown>>;
}

const TEXT_SUBTITLE_CODECS = new Set([
    'ass',
    'mov_text',
    'srt',
    'ssa',
    'subrip',
    'text',
    'webvtt',
]);

export function parseAdaptiveMediaProbe(value: unknown): AdaptiveMediaLayout {
    const streams = Array.isArray(
        (value as { streams?: unknown } | null)?.streams
    )
        ? ((value as { streams: ProbeStream[] }).streams ?? [])
        : [];
    const normalized = streams
        .map(normalizeStream)
        .filter((stream): stream is AdaptiveMediaStream => stream !== null);
    const video = normalized.find((stream) => stream.kind === 'video');
    if (!video) throw new Error('The source has no video stream');
    return {
        video,
        audio: normalized.filter((stream) => stream.kind === 'audio'),
        subtitles: normalized.filter(
            (stream) =>
                stream.kind === 'subtitle' &&
                TEXT_SUBTITLE_CODECS.has(stream.codecName)
        ),
    };
}

export function buildAdaptiveFfmpegArgs(
    layout: AdaptiveMediaLayout
): readonly string[] {
    const copyVideo = isWebSafeH264(layout.video);
    const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-i',
        'pipe:0',
        '-map',
        `0:${layout.video.index}`,
        '-an',
        '-sn',
        '-dn',
        '-c:v',
        copyVideo ? 'copy' : 'libx264',
        ...(copyVideo
            ? [
                  // MKV commonly stores SPS/PPS only as stream extradata.
                  // A growing EVENT playlist can begin at any later segment,
                  // so repeat those headers at every keyframe and make each
                  // copied H.264 segment independently decodable.
                  '-bsf:v',
                  'h264_mp4toannexb,dump_extra=freq=keyframe',
              ]
            : ['-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']),
        ...hlsOutput('video-%06d.ts', 'video.m3u8', true),
    ];
    layout.audio.forEach((stream, index) => {
        args.push(
            '-map',
            `0:${stream.index}`,
            '-vn',
            '-sn',
            '-dn',
            '-c:a',
            'aac',
            '-profile:a',
            'aac_low',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-b:a',
            '192k',
            ...hlsOutput(`audio-${index}-%06d.ts`, `audio-${index}.m3u8`)
        );
    });
    layout.subtitles.forEach((stream, index) => {
        args.push(
            '-map',
            `0:${stream.index}`,
            '-vn',
            '-an',
            '-dn',
            '-c:s',
            'webvtt',
            '-f',
            'segment',
            '-segment_time',
            '6',
            '-segment_list',
            `subtitle-${index}.csv`,
            '-segment_list_type',
            'csv',
            '-segment_format',
            'webvtt',
            `subtitle-${index}-%06d.vtt`
        );
    });
    return args;
}

export function buildAdaptiveMasterManifest(
    layout: AdaptiveMediaLayout
): string {
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        // The renditions grow while FFmpeg reads the source. Tell native HLS
        // clients (notably Safari) to start at the beginning instead of the
        // temporary live edge, where video can outrun encoded audio.
        '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES',
        '#EXT-X-INDEPENDENT-SEGMENTS',
    ];
    const defaultAudio = preferredSpanishTrack(layout.audio);
    layout.audio.forEach((track, index) => {
        lines.push(
            mediaLine('AUDIO', 'audio', track, index, index === defaultAudio)
        );
    });
    const defaultSubtitle = preferredSpanishTrack(layout.subtitles);
    layout.subtitles.forEach((track, index) => {
        lines.push(
            mediaLine(
                'SUBTITLES',
                'subtitles',
                track,
                index,
                index === defaultSubtitle
            )
        );
    });
    const bandwidth = Math.max(
        1_000_000,
        (layout.video.bitRate ?? 7_500_000) +
            Math.max(
                0,
                ...layout.audio.map((track) => track.bitRate ?? 256_000)
            )
    );
    const attributes = [`BANDWIDTH=${bandwidth}`];
    if (layout.video.width && layout.video.height) {
        attributes.push(
            `RESOLUTION=${layout.video.width}x${layout.video.height}`
        );
    }
    if (layout.audio.length) attributes.push('AUDIO="audio"');
    if (layout.subtitles.length) attributes.push('SUBTITLES="subtitles"');
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`, 'video.m3u8');
    return `${lines.join('\n')}\n`;
}

function normalizeStream(stream: ProbeStream): AdaptiveMediaStream | null {
    if (!Number.isInteger(stream.index) || typeof stream.index !== 'number') {
        return null;
    }
    const kind =
        stream.codec_type === 'video'
            ? 'video'
            : stream.codec_type === 'audio'
              ? 'audio'
              : stream.codec_type === 'subtitle'
                ? 'subtitle'
                : null;
    if (!kind) return null;
    const codecName = text(stream.codec_name).toLowerCase();
    return {
        index: stream.index,
        codecName,
        kind,
        language: text(stream.tags?.['language']) || 'und',
        title: text(stream.tags?.['title']),
        ...(positiveInteger(stream.width)
            ? { width: Number(stream.width) }
            : {}),
        ...(positiveInteger(stream.height)
            ? { height: Number(stream.height) }
            : {}),
        ...(positiveInteger(stream.bit_rate)
            ? { bitRate: Number(stream.bit_rate) }
            : {}),
        ...(positiveInteger(stream.bits_per_raw_sample)
            ? { bitsPerRawSample: Number(stream.bits_per_raw_sample) }
            : {}),
        ...(text(stream.pix_fmt)
            ? { pixelFormat: text(stream.pix_fmt).toLowerCase() }
            : {}),
        ...(text(stream.profile) ? { profile: text(stream.profile) } : {}),
    };
}

function isWebSafeH264(stream: AdaptiveMediaStream): boolean {
    if (stream.codecName !== 'h264') return false;
    if ((stream.bitsPerRawSample ?? 8) > 8) return false;
    const pixelFormat = stream.pixelFormat?.toLowerCase();
    if (pixelFormat !== 'yuv420p' && pixelFormat !== 'yuvj420p') {
        return false;
    }
    return !/high\s*(?:10|4:2:2|4:4:4)|cavlc\s*4:4:4/iu.test(
        stream.profile ?? ''
    );
}

function hlsOutput(
    segmentPattern: string,
    playlist: string,
    independent = false
): string[] {
    return [
        // Keep MPEG-TS timestamps on the same zero-based timeline as the
        // absolute WebVTT cue timestamps. Without this, the MPEG-TS muxer
        // adds its default delay while hls.js subtracts that delay from VTT
        // cues that do not carry an X-TIMESTAMP-MAP.
        '-muxdelay',
        '0',
        '-f',
        'hls',
        '-hls_time',
        '6',
        '-hls_list_size',
        '0',
        '-hls_playlist_type',
        'event',
        '-hls_allow_cache',
        '0',
        '-hls_flags',
        independent ? 'temp_file+independent_segments' : 'temp_file',
        '-hls_segment_filename',
        segmentPattern,
        playlist,
    ];
}

function mediaLine(
    type: 'AUDIO' | 'SUBTITLES',
    group: string,
    track: AdaptiveMediaStream,
    index: number,
    isDefault: boolean
): string {
    const fallback =
        type === 'AUDIO' ? `Audio ${index + 1}` : `Subtítulos ${index + 1}`;
    const name = quoted(
        track.title || languageName(track.language) || fallback
    );
    const uri =
        type === 'AUDIO' ? `audio-${index}.m3u8` : `subtitle-${index}.m3u8`;
    const attributes = [
        `TYPE=${type}`,
        `GROUP-ID="${group}"`,
        `NAME="${name}"`,
        `LANGUAGE="${quoted(track.language)}"`,
        `AUTOSELECT=YES`,
        `DEFAULT=${isDefault ? 'YES' : 'NO'}`,
        type === 'SUBTITLES' ? 'FORCED=NO' : '',
        `URI="${uri}"`,
    ]
        .filter(Boolean)
        .join(',');
    return `#EXT-X-MEDIA:${attributes}`;
}

function preferredSpanishTrack(tracks: readonly AdaptiveMediaStream[]): number {
    const index = tracks.findIndex((track) => {
        const value = `${track.language} ${track.title}`.toLocaleLowerCase();
        return /(^|[\s_-])(es|spa|spanish|español|espanol|latino)([\s_-]|$)/u.test(
            value
        );
    });
    return index >= 0 ? index : tracks.length ? 0 : -1;
}

function languageName(language: string): string {
    const normalized = language.toLowerCase();
    if (normalized === 'spa' || normalized.startsWith('es')) return 'Español';
    if (normalized === 'eng' || normalized.startsWith('en')) return 'English';
    if (normalized === 'jpn' || normalized.startsWith('ja')) return '日本語';
    return language === 'und' ? '' : language;
}

function quoted(value: string): string {
    return [...value]
        .filter((character) => {
            const code = character.charCodeAt(0);
            return (
                code >= 32 &&
                code !== 127 &&
                character !== '"' &&
                character !== '\\'
            );
        })
        .join('')
        .slice(0, 120);
}

function positiveInteger(value: unknown): boolean {
    return Number.isFinite(Number(value)) && Number(value) > 0;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}
