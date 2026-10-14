import {
    buildAdaptiveFfmpegArgs,
    buildAdaptiveMasterManifest,
    parseAdaptiveMediaProbe,
} from './adaptive-media-layout';

describe('adaptive media layout', () => {
    const probe = {
        streams: [
            {
                index: 0,
                codec_type: 'video',
                codec_name: 'h264',
                profile: 'High',
                pix_fmt: 'yuv420p',
                bits_per_raw_sample: '8',
                width: 1920,
                height: 1080,
                bit_rate: '6000000',
            },
            {
                index: 1,
                codec_type: 'audio',
                codec_name: 'aac',
                tags: { language: 'jpn', title: 'Japanese' },
            },
            {
                index: 2,
                codec_type: 'subtitle',
                codec_name: 'ass',
                tags: {
                    language: 'spa',
                    title: 'Español (América Latina)',
                },
            },
            {
                index: 3,
                codec_type: 'subtitle',
                codec_name: 'ass',
                tags: { language: 'eng', title: 'English (US)' },
            },
            {
                index: 4,
                codec_type: 'subtitle',
                codec_name: 'hdmv_pgs_subtitle',
                tags: { language: 'spa' },
            },
        ],
    };

    it('keeps audio and text subtitles but excludes bitmap subtitles', () => {
        const layout = parseAdaptiveMediaProbe(probe);

        expect(layout.video).toMatchObject({
            codecName: 'h264',
            index: 0,
            width: 1920,
            height: 1080,
        });
        expect(layout.audio.map((track) => track.index)).toEqual([1]);
        expect(layout.subtitles.map((track) => track.index)).toEqual([2, 3]);
    });

    it('pipes the source through stdin and segments ASS subtitles as WebVTT', () => {
        const args = buildAdaptiveFfmpegArgs(parseAdaptiveMediaProbe(probe));
        const command = args.join(' ');

        expect(command).toContain('-i pipe:0');
        expect(command).toContain(
            '-c:v copy -bsf:v h264_mp4toannexb,dump_extra=freq=keyframe'
        );
        expect(command).toContain('-map 0:1');
        expect(command).toContain(
            '-c:a aac -profile:a aac_low -ar 48000 -ac 2 -b:a 192k'
        );
        expect(command).toContain(
            '-segment_list subtitle-0.csv -segment_list_type csv -segment_format webvtt'
        );
        expect(command).toContain('subtitle-0-%06d.vtt');
        expect(command).toContain('-muxdelay 0 -f hls');
        expect(command).not.toContain('-reset_timestamps');
        expect(command).not.toContain('secret-password');
    });

    it('copies web-safe H.264 but normalizes other or 10-bit video to 8-bit H.264', () => {
        const h264 = buildAdaptiveFfmpegArgs(parseAdaptiveMediaProbe(probe));
        const hevc = buildAdaptiveFfmpegArgs(
            parseAdaptiveMediaProbe({
                streams: [
                    {
                        ...probe.streams[0],
                        codec_name: 'hevc',
                    },
                ],
            })
        );
        const high10 = buildAdaptiveFfmpegArgs(
            parseAdaptiveMediaProbe({
                streams: [
                    {
                        ...probe.streams[0],
                        profile: 'High 10',
                        pix_fmt: 'yuv420p10le',
                        bits_per_raw_sample: '10',
                    },
                ],
            })
        );
        const unknownPixelFormat = buildAdaptiveFfmpegArgs(
            parseAdaptiveMediaProbe({
                streams: [{ ...probe.streams[0], pix_fmt: '' }],
            })
        );

        expect(h264.join(' ')).toContain('-c:v copy');
        expect(hevc.join(' ')).toContain(
            '-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p'
        );
        expect(high10.join(' ')).toContain(
            '-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p'
        );
        expect(high10.join(' ')).not.toContain('-c:v copy');
        expect(unknownPixelFormat.join(' ')).toContain(
            '-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p'
        );
    });

    it('builds alternate audio and subtitle groups with Spanish preferred', () => {
        const manifest = buildAdaptiveMasterManifest(
            parseAdaptiveMediaProbe(probe)
        );

        expect(manifest).toContain('TYPE=AUDIO');
        expect(manifest).toContain('#EXT-X-START:TIME-OFFSET=0,PRECISE=YES');
        expect(manifest).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
        expect(manifest).toContain('LANGUAGE="jpn"');
        expect(manifest).toContain(
            'TYPE=SUBTITLES,GROUP-ID="subtitles",NAME="Español (América Latina)",LANGUAGE="spa",AUTOSELECT=YES,DEFAULT=YES'
        );
        expect(manifest).toContain(
            'NAME="English (US)",LANGUAGE="eng",AUTOSELECT=YES,DEFAULT=NO'
        );
        expect(manifest).toContain('RESOLUTION=1920x1080');
        expect(manifest).toContain('AUDIO="audio",SUBTITLES="subtitles"');
        expect(manifest).toContain('\nvideo.m3u8\n');
    });
});
