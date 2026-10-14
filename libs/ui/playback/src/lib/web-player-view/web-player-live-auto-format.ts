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
import {
    type ResolvedPortalPlayback,
    VideoPlayer,
} from '@iptvnator/shared/interfaces';

/** One source-format attempt per mounted logical live session, never an engine switch. */
export class WebPlayerLiveAutoFormat {
    private callback?: AfterRenderRef;
    private destroyed = false;
    // Metadata refreshes reuse the transport revision. The returned ownership
    // value is opaque; URLs/headers remain solely in the canonical source input.
    private readonly origin = linkedSignal({
        source: () => this.deps.playback(),
        computation: (
            source,
            previous?: { source: ResolvedPortalPlayback | null; value: symbol }
        ) =>
            previous && sameLiveTransport(source, previous.source)
                ? previous.value
                : Symbol(),
    });
    private readonly intent = computed(() => {
        void this.deps.intent();
        void this.deps.player();
        void this.deps.autoEnabled();
        return Symbol();
    });
    private readonly state = linkedSignal({
        source: () => ({ key: this.deps.sessionKey(), origin: this.origin() }),
        computation: (
            source,
            previous?: {
                source: { key: string; origin: symbol };
                value: {
                    attempted: boolean;
                    started: boolean;
                    pending: boolean;
                    useFallback: boolean;
                };
            }
        ) => ({
            attempted:
                previous?.source.key === source.key &&
                !!previous.value.attempted,
            started:
                previous?.source.key === source.key && !!previous.value.started,
            pending: false,
            useFallback: false,
        }),
    });
    readonly pending = computed(() => this.state().pending);
    private readonly useFallback = computed(() => this.state().useFallback);
    readonly playback = computed(() => {
        const playback = this.deps.playback();
        const fallbackUrl = getLiveAutoFallbackUrl(playback);
        return this.useFallback() && playback && fallbackUrl
            ? {
                  ...playback,
                  streamUrl: fallbackUrl,
                  liveAutoFallbackUrl: undefined,
                  liveAutoTsUrl: undefined,
              }
            : playback;
    });

    constructor(
        private readonly deps: {
            playback: Signal<ResolvedPortalPlayback | null>;
            sessionKey: Signal<string>;
            player: Signal<VideoPlayer>;
            intent: () => unknown;
            autoEnabled: () => boolean;
            injector: Injector;
        }
    ) {}

    started(): void {
        this.state.update((state) => ({ ...state, started: true }));
    }

    tryFallback(issue: PlaybackDiagnostic): boolean {
        const source = this.deps.playback();
        const state = this.state();
        const fallbackUrl = getLiveAutoFallbackUrl(source);
        if (
            this.destroyed ||
            !this.deps.autoEnabled() ||
            state.attempted ||
            state.started ||
            !this.deps.sessionKey() ||
            !source ||
            !fallbackUrl ||
            source.isLive !== true ||
            source.contentInfo ||
            source.drm ||
            this.deps.player() === VideoPlayer.EmbeddedMpv ||
            !isAlternateLiveTransport(source.streamUrl, fallbackUrl) ||
            !isEligibleInitialFailure(issue)
        )
            return false;
        this.state.set({ ...state, attempted: true, pending: true });
        const origin = this.origin();
        const key = this.deps.sessionKey();
        const intent = this.intent();
        this.callback?.destroy();
        // Render an empty application first. All web transports synchronously destroy
        // their loaders in ngOnDestroy before the TS header handoff may start.
        this.callback = afterNextRender(
            () => {
                this.callback = undefined;
                if (
                    this.destroyed ||
                    origin !== this.origin() ||
                    key !== this.deps.sessionKey()
                )
                    return;
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

function sameLiveTransport(
    a: ResolvedPortalPlayback | null,
    b: ResolvedPortalPlayback | null
): boolean {
    if (!a || !b) return a === b;
    const headerKeys = new Set([
        ...Object.keys(a.headers ?? {}),
        ...Object.keys(b.headers ?? {}),
    ]);
    return (
        a.streamUrl === b.streamUrl &&
        a.liveAutoFallbackUrl === b.liveAutoFallbackUrl &&
        a.liveAutoTsUrl === b.liveAutoTsUrl &&
        a.isLive === b.isLive &&
        a.drm === b.drm &&
        a.contentInfo === b.contentInfo &&
        a.userAgent === b.userAgent &&
        a.referer === b.referer &&
        a.origin === b.origin &&
        [...headerKeys].every((key) => a.headers?.[key] === b.headers?.[key])
    );
}

function getLiveAutoFallbackUrl(
    playback: ResolvedPortalPlayback | null
): string | undefined {
    return playback?.liveAutoFallbackUrl ?? playback?.liveAutoTsUrl;
}

function isAlternateLiveTransport(
    primaryUrl: string,
    fallbackUrl: string
): boolean {
    const kinds = new Set([
        resolvePlaybackUrlSourceKind(primaryUrl),
        resolvePlaybackUrlSourceKind(fallbackUrl),
    ]);
    return kinds.size === 2 && kinds.has('hls') && kinds.has('mpegts');
}

function isEligibleInitialFailure(issue: PlaybackDiagnostic): boolean {
    // A key, license or media-stage error must not be treated as a transport
    // mismatch. Those requests may carry sensitive authorization semantics.
    if (
        issue.code === 'drm-or-encryption' ||
        (issue.drmSystems?.length ?? 0) > 0 ||
        (issue.hls &&
            !['manifest', 'level', 'segment'].includes(issue.hls.stage)) ||
        issue.shaka?.stage === 'license' ||
        issue.shaka?.category === 'drm'
    ) {
        return false;
    }

    const status = issue.httpStatus;
    const isHttpFailure =
        issue.code === 'network-error' &&
        status !== undefined &&
        // An expired/missing same-origin media session needs authentication,
        // not a transport change. Trying the alternate only repeats the 401.
        status !== 401 &&
        status >= 400 &&
        status <= 599;
    if (isHttpFailure) {
        return true;
    }

    if (status !== undefined) {
        return false;
    }

    // Browsers frequently reduce an initial source failure to MediaError 4,
    // with neither an HTTP status nor an engine detail. Try the one advertised
    // alternate before surfacing that opaque terminal diagnostic.
    return (
        issue.nativeErrorCode === 4 ||
        (issue.vhs?.mediaErrorCode === 4 &&
            issue.vhs.engineType === 'unknown')
    );
}
