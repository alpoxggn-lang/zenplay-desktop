import {
    afterNextRender,
    computed,
    linkedSignal,
    type AfterRenderRef,
    type Injector,
    type Signal,
} from '@angular/core';
import {
    type PlaybackDiagnostic,
    resolvePlaybackUrlSourceKind,
} from '@iptvnator/playback/util';
import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';
import { isAdaptiveHlsMasterUrl } from '../web-video-support/adaptive-hls-load-policy';

/** One HLS-to-direct attempt for legacy, non-adaptive VOD sources. */
export class WebPlayerDirectFormatFallback {
    private callback?: AfterRenderRef;
    private destroyed = false;
    private readonly origin = linkedSignal({
        source: () => this.deps.playback(),
        computation: (
            source,
            previous?: { source: ResolvedPortalPlayback | null; value: symbol }
        ) =>
            previous && sameTransport(source, previous.source)
                ? previous.value
                : Symbol(),
    });
    private readonly intent = computed(() => {
        void this.deps.intent();
        return Symbol();
    });
    private readonly state = linkedSignal({
        source: () => ({ key: this.deps.sessionKey(), origin: this.origin() }),
        computation: (
            source,
            previous?: {
                source: { key: string; origin: symbol };
                value: FallbackState;
            }
        ): FallbackState => ({
            attempted:
                previous?.source.key === source.key &&
                previous.source.origin === source.origin &&
                !!previous.value.attempted,
            started:
                previous?.source.key === source.key &&
                previous.source.origin === source.origin &&
                !!previous.value.started,
            pending: false,
            useFallback: false,
        }),
    });
    readonly pending = computed(() => this.state().pending);
    readonly preparing = computed(
        () =>
            isAdaptiveHlsMasterUrl(this.deps.playback()?.streamUrl ?? '') &&
            !this.state().started
    );
    private readonly useFallback = computed(() => this.state().useFallback);
    readonly playback = computed(() => {
        const playback = this.deps.playback();
        const fallbackUrl = playback?.webDirectFallbackUrl;
        return this.useFallback() && playback && fallbackUrl
            ? {
                  ...playback,
                  streamUrl: fallbackUrl,
                  webDirectFallbackUrl: undefined,
              }
            : playback;
    });

    constructor(
        private readonly deps: {
            playback: Signal<ResolvedPortalPlayback | null>;
            sessionKey: Signal<string>;
            intent: () => unknown;
            injector: Injector;
        }
    ) {}

    started(): void {
        this.state.update((state) => ({ ...state, started: true }));
    }

    tryFallback(issue: PlaybackDiagnostic): boolean {
        const source = this.deps.playback();
        const state = this.state();
        const fallbackUrl = source?.webDirectFallbackUrl;
        if (
            this.destroyed ||
            state.attempted ||
            state.started ||
            !this.deps.sessionKey() ||
            !source ||
            // ZenPlay generated this HLS because the raw MKV was not browser
            // safe. Never silently return to that MKV, regardless of whether
            // the adaptive failure is network-, container-, or codec-related.
            isAdaptiveHlsMasterUrl(source.streamUrl) ||
            !fallbackUrl ||
            source.isLive === true ||
            !source.contentInfo ||
            source.drm ||
            resolvePlaybackUrlSourceKind(source.streamUrl) !== 'hls' ||
            resolvePlaybackUrlSourceKind(fallbackUrl) !== 'native' ||
            !isEligibleAdaptiveFailure(issue)
        ) {
            return false;
        }

        this.state.set({ ...state, attempted: true, pending: true });
        const origin = this.origin();
        const key = this.deps.sessionKey();
        const intent = this.intent();
        this.callback?.destroy();
        this.callback = afterNextRender(
            () => {
                this.callback = undefined;
                if (
                    this.destroyed ||
                    origin !== this.origin() ||
                    key !== this.deps.sessionKey()
                ) {
                    return;
                }
                this.state.update((current) => ({
                    ...current,
                    pending: false,
                    useFallback: intent === this.intent(),
                }));
            },
            { injector: this.deps.injector }
        );
        return true;
    }

    destroy(): void {
        this.destroyed = true;
        this.callback?.destroy();
        this.callback = undefined;
    }
}

interface FallbackState {
    readonly attempted: boolean;
    readonly started: boolean;
    readonly pending: boolean;
    readonly useFallback: boolean;
}

function sameTransport(
    a: ResolvedPortalPlayback | null,
    b: ResolvedPortalPlayback | null
): boolean {
    if (!a || !b) return a === b;
    return (
        a.streamUrl === b.streamUrl &&
        a.webDirectFallbackUrl === b.webDirectFallbackUrl &&
        a.contentInfo?.playlistId === b.contentInfo?.playlistId &&
        a.contentInfo?.contentType === b.contentInfo?.contentType &&
        a.contentInfo?.contentXtreamId === b.contentInfo?.contentXtreamId
    );
}

function isEligibleAdaptiveFailure(issue: PlaybackDiagnostic): boolean {
    if (
        issue.code === 'drm-or-encryption' ||
        (issue.drmSystems?.length ?? 0) > 0 ||
        issue.shaka?.stage === 'license' ||
        issue.shaka?.category === 'drm' ||
        issue.httpStatus === 401
    ) {
        return false;
    }

    // Preparation timeouts and backend 5xx must remain visible instead of
    // replacing the source with another transport that hides the diagnosis.
    if (
        (issue.httpStatus !== undefined && issue.httpStatus >= 500) ||
        (issue.code === 'network-error' && issue.httpStatus === undefined)
    ) {
        return false;
    }
    if (
        issue.httpStatus !== undefined &&
        issue.httpStatus >= 400 &&
        issue.httpStatus <= 599
    ) {
        return true;
    }
    return (
        issue.code === 'media-decode-error' ||
        issue.code === 'unsupported-codec' ||
        issue.code === 'unsupported-container' ||
        issue.nativeErrorCode === 4 ||
        issue.vhs?.mediaErrorCode === 4
    );
}
