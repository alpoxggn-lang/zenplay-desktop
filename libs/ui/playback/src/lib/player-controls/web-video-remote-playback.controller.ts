import { signal } from '@angular/core';
import {
    type RemotePlaybackTicketRequest,
    resolveRemotePlaybackTicketRequest,
} from './web-video-remote-playback-source';
import { WebVideoRemotePlaybackSync } from './web-video-remote-playback-sync';
import { WebVideoRemotePlaybackAvailability } from './web-video-remote-playback-availability';
import {
    prepareRemotePlaybackTicket,
    RemotePlaybackTicketError,
    revokeRemotePlaybackTicket,
} from './web-video-remote-playback-ticket';
import type { WebVideoRemotePlaybackHost } from './web-video-remote-playback-host';
import { attachWebVideoRemotePlaybackListeners } from './web-video-remote-playback-listeners';
import {
    DEFAULT_PREPARE_RETRY_MS,
    EMPTY_REMOTE_PLAYBACK_STATE,
    isRecoverableTicketError,
    isRemotePlaybackActive,
    readRemotePlayback,
    type WebkitRemoteVideo,
    type WebVideoRemotePlaybackState,
    WEBKIT_PICKER_TIMEOUT_MS,
} from './web-video-remote-playback-state';

export type { WebVideoRemotePlaybackState } from './web-video-remote-playback-state';

/**
 * Progressive web casting: use the browser's Remote Playback/AirPlay picker
 * only when it exists, and feed it a short-lived backend URL rather than a
 * provider URL or the browser's HttpOnly media cookie.
 */
export class WebVideoRemotePlaybackController {
    readonly state = signal<WebVideoRemotePlaybackState>(
        EMPTY_REMOTE_PLAYBACK_STATE
    );

    private sourceVideo: HTMLVideoElement | null = null;
    private remoteVideo: WebkitRemoteVideo | null = null;
    private remote: RemotePlayback | null = null;
    private generation = 0;
    private readonly availability = new WebVideoRemotePlaybackAvailability();
    private prepareAbort: AbortController | null = null;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private promptTimer: ReturnType<typeof setTimeout> | null = null;
    private ticketRequest: RemotePlaybackTicketRequest | null = null;
    private ticketUrl: string | null = null;
    private promptPending = false;
    private mediaSync: WebVideoRemotePlaybackSync | null = null;
    private host: WebVideoRemotePlaybackHost | null = null;
    private remoteSessionActive = false;
    private detachListeners: Array<() => void> = [];

    constructor(
        private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
    ) {}

    attach(
        sourceVideo: HTMLVideoElement | null,
        sourceUrl: string | null,
        host: WebVideoRemotePlaybackHost | null = null
    ): void {
        this.detach(true);
        if (!sourceVideo || !sourceUrl) return;
        const ticketRequest = resolveRemotePlaybackTicketRequest(
            sourceUrl,
            sourceVideo.ownerDocument.baseURI
        );
        if (!ticketRequest) return;

        const remoteVideo = sourceVideo.ownerDocument.createElement(
            'video'
        ) as WebkitRemoteVideo;
        const remote = readRemotePlayback(remoteVideo);
        const hasStandardPicker = typeof remote?.prompt === 'function';
        const hasAirPlayPicker =
            typeof remoteVideo.webkitShowPlaybackTargetPicker === 'function';
        if (!hasStandardPicker && !hasAirPlayPicker) return;

        this.sourceVideo = sourceVideo;
        this.remoteVideo = remoteVideo;
        this.remote = remote;
        this.ticketRequest = ticketRequest;
        this.host = host;
        remoteVideo.preload = 'none';
        remoteVideo.playsInline = true;
        remoteVideo.disableRemotePlayback = false;
        remoteVideo.setAttribute('x-webkit-airplay', 'allow');
        remoteVideo.setAttribute('aria-hidden', 'true');
        remoteVideo.tabIndex = -1;
        Object.assign(remoteVideo.style, {
            height: '1px',
            left: '-10000px',
            opacity: '0',
            pointerEvents: 'none',
            position: 'fixed',
            top: '0',
            width: '1px',
        });
        sourceVideo.ownerDocument.body?.append(remoteVideo);

        this.state.set({
            ...EMPTY_REMOTE_PLAYBACK_STATE,
            active: isRemotePlaybackActive(remoteVideo, remote),
            preparing: true,
            supported: true,
        });
        attachWebVideoRemotePlaybackListeners({
            video: remoteVideo,
            remote,
            listen: (target, eventName, listener) =>
                this.listen(target, eventName, listener),
            onConnecting: () => {
                this.promptPending = true;
                this.refreshState();
            },
            onConnect: () => this.beginRemotePlayback(),
            onDisconnect: () => this.remoteDisconnected(),
            onAvailability: (available) => {
                this.state.update((state) => ({
                    ...state,
                    available,
                    canPrompt:
                        Boolean(this.ticketUrl) &&
                        !this.promptPending &&
                        available !== false,
                }));
            },
        });
        this.mediaSync = new WebVideoRemotePlaybackSync(
            sourceVideo,
            remoteVideo,
            () => this.refreshState()
        );
        this.mediaSync.attach((target, eventName, listener) =>
            this.listen(target, eventName, listener)
        );
        this.availability.watch(remote, (available) => {
            this.state.update((state) => ({
                ...state,
                available,
                canPrompt:
                    Boolean(this.ticketUrl) && !this.promptPending && available,
            }));
        });
        void this.prepareTicket(this.generation);
    }

    prompt(): void {
        const state = this.state();
        const remoteVideo = this.remoteVideo;
        if (
            !remoteVideo ||
            !this.ticketUrl ||
            !state.canPrompt ||
            this.promptPending
        ) {
            return;
        }
        this.mediaSync?.preparePrompt();
        this.promptPending = true;
        this.refreshState();

        try {
            const generation = this.generation;
            const remote = this.remote;
            const isCurrentPrompt = () =>
                generation === this.generation &&
                remote === this.remote &&
                remoteVideo === this.remoteVideo;
            if (typeof remote?.prompt === 'function') {
                void remote.prompt().then(
                    () => {
                        if (!isCurrentPrompt()) return;
                        if (remote.state === 'connected') {
                            this.promptPending = false;
                            this.beginRemotePlayback();
                        } else if (remote.state === 'connecting') {
                            // The picker promise can resolve before the
                            // receiver finishes connecting. Keep its ticket
                            // until an explicit connect/disconnect event.
                            this.refreshState();
                        } else {
                            this.cancelPrompt();
                        }
                    },
                    () => {
                        if (!isCurrentPrompt()) return;
                        this.cancelPrompt();
                    }
                );
                return;
            }
            remoteVideo.webkitShowPlaybackTargetPicker?.();
            this.schedulePromptReset();
        } catch {
            this.cancelPrompt();
        }
    }

    detach(restoreLocal = false): void {
        const remoteWasActive = this.remoteSessionActive;
        this.generation += 1;
        this.prepareAbort?.abort();
        this.prepareAbort = null;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.clearPromptTimer();
        this.availability.cancel();
        for (const detach of this.detachListeners.splice(0)) detach();
        if (this.remoteVideo && remoteWasActive) this.remoteVideo.pause();
        this.finishRemotePlayback(restoreLocal, false);
        this.releaseTicket(false);
        this.remoteVideo?.remove();
        this.sourceVideo = this.remoteVideo = null;
        this.remote = null;
        this.mediaSync = null;
        this.host = null;
        this.ticketRequest = null;
        this.ticketUrl = null;
        this.promptPending = false;
        this.remoteSessionActive = false;
        this.state.set(EMPTY_REMOTE_PLAYBACK_STATE);
    }

    private async prepareTicket(generation: number): Promise<void> {
        const request = this.ticketRequest;
        const remoteVideo = this.remoteVideo;
        if (!request || !remoteVideo || generation !== this.generation) return;
        this.prepareAbort?.abort();
        const controller = new AbortController();
        this.prepareAbort = controller;
        this.state.update((state) => ({
            ...state,
            canPrompt: false,
            preparing: true,
            retrying: false,
        }));
        try {
            const prepared = await prepareRemotePlaybackTicket(
                this.fetchImpl,
                request,
                controller.signal
            );
            if (
                generation !== this.generation ||
                remoteVideo !== this.remoteVideo
            ) {
                void revokeRemotePlaybackTicket(
                    this.fetchImpl,
                    prepared.url,
                    request.endpoint
                );
                return;
            }
            const previousUrl = this.ticketUrl;
            this.ticketUrl = prepared.url;
            remoteVideo.src = prepared.url;
            if (previousUrl && previousUrl !== prepared.url) {
                void revokeRemotePlaybackTicket(
                    this.fetchImpl,
                    previousUrl,
                    request.endpoint
                );
            }
            this.scheduleTicketRefresh(generation, prepared.expiresInSeconds);
            this.state.update((state) => ({
                ...state,
                canPrompt: state.available !== false,
                preparing: false,
            }));
        } catch (error) {
            if (!controller.signal.aborted && generation === this.generation) {
                if (isRecoverableTicketError(error)) {
                    this.schedulePrepareRetry(
                        generation,
                        error instanceof RemotePlaybackTicketError
                            ? (error.retryAfterMs ?? DEFAULT_PREPARE_RETRY_MS)
                            : DEFAULT_PREPARE_RETRY_MS
                    );
                } else {
                    this.detach();
                }
            }
        } finally {
            if (this.prepareAbort === controller) this.prepareAbort = null;
        }
    }

    private scheduleTicketRefresh(
        generation: number,
        expiresInSeconds: number
    ): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(
            () => {
                this.refreshTimer = null;
                if (!this.state().active && !this.promptPending) {
                    void this.prepareTicket(generation);
                }
            },
            Math.max(10_000, expiresInSeconds * 800)
        );
    }

    private beginRemotePlayback(): void {
        if (!this.mediaSync || !this.remoteVideo) return;
        this.clearPromptTimer();
        this.promptPending = false;
        if (!this.remoteSessionActive) {
            const initialState = this.mediaSync.begin();
            this.remoteSessionActive = true;
            this.host?.beginRemotePlayback(this.remoteVideo, initialState);
        }
        this.refreshState(true);
    }

    private finishRemotePlayback(
        restoreLocal = true,
        restoreRemotePosition = true
    ): void {
        this.clearPromptTimer();
        this.refreshState(false);
        if (this.remoteSessionActive && this.mediaSync) {
            const resume = this.mediaSync.finish(restoreRemotePosition);
            if (this.host) {
                this.host.finishRemotePlayback(resume, restoreLocal);
            } else if (restoreLocal) {
                this.mediaSync.restoreSource(resume);
            }
        }
        this.remoteSessionActive = false;
        this.promptPending = false;
    }

    private remoteDisconnected(): void {
        if (!this.state().active && !this.promptPending) return;
        this.finishRemotePlayback();
        this.releaseTicket(true);
    }

    private cancelPrompt(): void {
        if (!this.promptPending) return;
        this.promptPending = false;
        this.releaseTicket(true);
    }

    private releaseTicket(refresh: boolean): void {
        const request = this.ticketRequest;
        const ticketUrl = this.ticketUrl;
        this.ticketUrl = null;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        this.remoteVideo?.removeAttribute('src');
        this.state.update((state) => ({
            ...state,
            canPrompt: false,
            preparing: refresh && Boolean(request && this.remoteVideo),
            retrying: false,
        }));
        if (ticketUrl && request) {
            void revokeRemotePlaybackTicket(
                this.fetchImpl,
                ticketUrl,
                request.endpoint
            );
        }
        if (refresh && request && this.remoteVideo) {
            void this.prepareTicket(this.generation);
        }
    }

    private refreshState(forceActive?: boolean): void {
        const active =
            forceActive ??
            isRemotePlaybackActive(this.remoteVideo, this.remote);
        this.state.update((state) => ({
            ...state,
            active,
            canPrompt:
                Boolean(this.ticketUrl) &&
                !this.promptPending &&
                state.available !== false,
        }));
    }

    private schedulePrepareRetry(generation: number, delayMs: number): void {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.state.update((state) => ({
            ...state,
            canPrompt: false,
            preparing: false,
            retrying: true,
        }));
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (generation === this.generation) {
                void this.prepareTicket(generation);
            }
        }, Math.max(1_000, delayMs));
    }

    private schedulePromptReset(): void {
        this.clearPromptTimer();
        this.promptTimer = setTimeout(() => {
            this.promptTimer = null;
            if (!isRemotePlaybackActive(this.remoteVideo, this.remote)) {
                this.cancelPrompt();
            }
        }, WEBKIT_PICKER_TIMEOUT_MS);
    }

    private clearPromptTimer(): void {
        if (this.promptTimer) clearTimeout(this.promptTimer);
        this.promptTimer = null;
    }

    private listen(
        target: EventTarget,
        eventName: string,
        listener: EventListener
    ): void {
        target.addEventListener(eventName, listener);
        this.detachListeners.push(() =>
            target.removeEventListener(eventName, listener)
        );
    }
}
