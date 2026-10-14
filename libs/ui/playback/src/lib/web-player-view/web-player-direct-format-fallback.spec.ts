import { Component, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
    PlaybackDiagnosticCode,
    PlaybackDiagnosticSource,
    type PlaybackDiagnostic,
} from '@iptvnator/playback/util';
import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';
import { WebPlayerDirectFormatFallback } from './web-player-direct-format-fallback';

@Component({ template: '' })
class Host {}

const contentInfo = {
    playlistId: 'zenplay',
    contentType: 'episode' as const,
    contentXtreamId: 910850,
};
const source: ResolvedPortalPlayback = {
    streamUrl: '/api/media/adaptive/series/910850.mkv/master.m3u8',
    webDirectFallbackUrl: '/api/media/series/910850.mkv',
    title: 'Episodio',
    contentInfo,
};
const failure: PlaybackDiagnostic = {
    code: PlaybackDiagnosticCode.NetworkError,
    source: PlaybackDiagnosticSource.Hls,
    sourceUrl: source.streamUrl,
    container: 'm3u8',
    player: 'html5',
    httpStatus: 503,
    audioCodecs: [],
    videoCodecs: [],
};
const decodeFailure: PlaybackDiagnostic = {
    ...failure,
    code: PlaybackDiagnosticCode.MediaDecodeError,
    httpStatus: undefined,
};

describe('adaptive VOD direct fallback', () => {
    const playback = signal<ResolvedPortalPlayback | null>(source);
    const sessionKey = signal('zenplay/episode/910850');
    const intent = signal(0);
    let controller: WebPlayerDirectFormatFallback;
    let fixture: ReturnType<typeof TestBed.createComponent<Host>>;

    beforeEach(() => {
        playback.set({ ...source });
        sessionKey.set('zenplay/episode/910850');
        intent.set(0);
        fixture = TestBed.createComponent(Host);
        controller = new WebPlayerDirectFormatFallback({
            playback,
            sessionKey,
            intent,
            injector: fixture.debugElement.injector.get(Injector),
        });
        fixture.detectChanges();
    });

    afterEach(() => {
        controller.destroy();
        fixture.destroy();
    });

    async function render() {
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
    }

    it('never replaces generated adaptive HLS with the raw MKV', async () => {
        for (const issue of [
            failure,
            { ...failure, httpStatus: 404 },
            decodeFailure,
            {
                ...decodeFailure,
                code: PlaybackDiagnosticCode.UnsupportedCodec,
            },
            {
                ...decodeFailure,
                code: PlaybackDiagnosticCode.UnsupportedContainer,
            },
        ]) {
            expect(controller.tryFallback(issue)).toBe(false);
        }
        await render();
        expect(controller.pending()).toBe(false);
        expect(controller.playback()).toEqual(source);
    });

    it('does not fall back after playback started, for auth, or for DRM', () => {
        controller.started();
        expect(controller.tryFallback(failure)).toBe(false);

        playback.set({ ...source });
        sessionKey.set('zenplay/episode/other');
        expect(controller.tryFallback({ ...failure, httpStatus: 401 })).toBe(
            false
        );
        expect(
            controller.tryFallback({
                ...failure,
                httpStatus: undefined,
                code: PlaybackDiagnosticCode.DrmOrEncryption,
            })
        ).toBe(false);
    });

    it('keeps the next adaptive episode protected from direct fallback', async () => {
        playback.set({
            ...source,
            streamUrl: '/api/media/adaptive/series/910851.mkv/master.m3u8',
            webDirectFallbackUrl: '/api/media/series/910851.mkv',
            contentInfo: { ...contentInfo, contentXtreamId: 910851 },
        });
        sessionKey.set('zenplay/episode/910851');
        expect(controller.tryFallback(decodeFailure)).toBe(false);
        await render();
        expect(controller.playback()?.streamUrl).toBe(
            '/api/media/adaptive/series/910851.mkv/master.m3u8'
        );
    });

    it('keeps adaptive HLS selected for backend 5xx and preparation timeouts', () => {
        expect(controller.tryFallback(failure)).toBe(false);
        expect(
            controller.tryFallback({
                ...failure,
                httpStatus: undefined,
                nativeErrorCode: 4,
                nativeErrorType: 'networkrequesttimeout',
            })
        ).toBe(false);
        expect(controller.pending()).toBe(false);
        expect(controller.playback()).toEqual(source);
    });

    it('rearms when a source changes under the same logical movie session', () => {
        controller.started();
        playback.set({
            ...source,
            streamUrl: '/api/media/adaptive/movie/991.mkv/master.m3u8',
            webDirectFallbackUrl: '/api/media/movie/991.mkv',
            contentInfo: {
                ...contentInfo,
                playlistId: 'alternative',
                contentType: 'vod',
                contentXtreamId: 991,
            },
        });

        expect(controller.tryFallback(decodeFailure)).toBe(false);
        expect(controller.playback()?.streamUrl).toBe(
            '/api/media/adaptive/movie/991.mkv/master.m3u8'
        );
    });
});
