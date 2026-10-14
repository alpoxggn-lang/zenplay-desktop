import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdaptiveMediaLayout } from './adaptive-media-layout';
import {
    publishAdaptiveMasterWhenReady,
    refreshAdaptiveSubtitleManifest,
} from './adaptive-media-files';

describe('adaptive media files', () => {
    let directory = '';

    const layout: AdaptiveMediaLayout = {
        video: {
            codecName: 'h264',
            index: 0,
            kind: 'video',
            language: 'und',
            title: '',
        },
        audio: [
            {
                codecName: 'aac',
                index: 1,
                kind: 'audio',
                language: 'jpn',
                title: 'Japanese',
            },
        ],
        subtitles: [
            {
                codecName: 'ass',
                index: 2,
                kind: 'subtitle',
                language: 'spa',
                title: 'Español',
            },
        ],
    };

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'zenplay-adaptive-files-'));
    });

    afterEach(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    it('publishes once video and audio are ready while subtitles have no cues', async () => {
        await rendition('video.m3u8', 'video-000000.ts', 'video');
        await rendition('audio-0.m3u8', 'audio-0-000000.ts', 'audio');

        await expect(
            publishAdaptiveMasterWhenReady(directory, layout, {
                pollMs: 5,
                timeoutMs: 1_000,
            })
        ).resolves.toBe(true);
        await expect(access(join(directory, 'master.m3u8'))).resolves.toBe(
            undefined
        );
        await expect(
            readFile(join(directory, 'subtitle-0.m3u8'), 'utf8')
        ).resolves.toContain(
            '#EXTINF:6.000000,\nsubtitle-0-filler.vtt?window=0'
        );
    });

    it('waits until the first referenced segment is non-empty', async () => {
        await rendition('video.m3u8', 'video-000000.ts', 'video');
        await rendition('audio-0.m3u8', 'audio-0-000000.ts', 'audio');
        await rendition('subtitle-0.m3u8', 'subtitle-0-000000.vtt', '');
        const publishing = publishAdaptiveMasterWhenReady(directory, layout, {
            pollMs: 5,
            timeoutMs: 1_000,
        });

        await expect(access(join(directory, 'master.m3u8'))).rejects.toThrow();
        await writeFile(
            join(directory, 'subtitle-0-000000.vtt'),
            'WEBVTT\n\n00:00.000 --> 00:06.000\nHola\n'
        );

        await expect(publishing).resolves.toBe(true);
    });

    it('times out without leaving a broken master manifest', async () => {
        await rendition('video.m3u8', 'video-000000.ts', 'video');

        await expect(
            publishAdaptiveMasterWhenReady(directory, layout, {
                pollMs: 5,
                timeoutMs: 20,
            })
        ).resolves.toBe(false);
        await expect(access(join(directory, 'master.m3u8'))).rejects.toThrow();
    });

    it('keeps sparse absolute WebVTT cues on their media timeline', async () => {
        await writeFile(
            join(directory, 'subtitle-0.csv'),
            [
                'subtitle-0-000000.vtt,0.000000,12.000000',
                'subtitle-0-000001.vtt,16.000000,18.000000',
                'subtitle-0-000002.vtt,24.000000,28.000000',
                '',
            ].join('\n')
        );
        await writeFile(
            join(directory, 'subtitle-0-000000.vtt'),
            'WEBVTT\n\n00:10.000 --> 00:12.000\nPrimero\n'
        );
        await writeFile(
            join(directory, 'subtitle-0-000001.vtt'),
            'WEBVTT\n\n00:16.000 --> 00:18.000\nSegundo\n'
        );
        await writeFile(
            join(directory, 'subtitle-0-000002.vtt'),
            'WEBVTT\n\n00:24.000 --> 00:28.000\nTercero\n'
        );

        await expect(
            refreshAdaptiveSubtitleManifest(directory, 0)
        ).resolves.toBe(true);
        let manifest = await readFile(
            join(directory, 'subtitle-0.m3u8'),
            'utf8'
        );

        expect(manifest).toContain('#EXT-X-TARGETDURATION:6');
        expect(manifest).toContain(
            '#EXTINF:6.000000,\nsubtitle-0-filler.vtt?window=0'
        );
        expect(manifest).toContain(
            '#EXTINF:2.000000,\nsubtitle-0-000000.vtt?window=2'
        );
        expect(manifest).toContain(
            '#EXTINF:2.000000,\nsubtitle-0-000001.vtt?window=4'
        );
        expect(manifest).toContain(
            '#EXTINF:4.000000,\nsubtitle-0-000002.vtt?window=6'
        );
        expect(manifest).not.toContain('#EXT-X-ENDLIST');

        await expect(
            refreshAdaptiveSubtitleManifest(directory, 0, { endList: true })
        ).resolves.toBe(true);
        manifest = await readFile(join(directory, 'subtitle-0.m3u8'), 'utf8');
        expect(manifest.endsWith('#EXT-X-ENDLIST\n')).toBe(true);
    });

    async function rendition(
        playlist: string,
        segment: string,
        contents: string
    ): Promise<void> {
        const subtitle = /^subtitle-(\d+)\.m3u8$/u.exec(playlist);
        if (subtitle) {
            await writeFile(
                join(directory, `subtitle-${subtitle[1]}.csv`),
                `${segment},0.000000,6.000000\n`
            );
        }
        await writeFile(
            join(directory, playlist),
            `#EXTM3U\n#EXTINF:6.0,\n${segment}\n`
        );
        await writeFile(join(directory, segment), contents);
    }
});
