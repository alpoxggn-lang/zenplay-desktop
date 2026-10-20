import { Directive, effect, input, untracked } from '@angular/core';
import { WebVideoRemotePlaybackController } from './web-video-remote-playback.controller';
import {
    isWebVideoRemotePlaybackHost,
    type WebVideoRemotePlaybackHost,
} from './web-video-remote-playback-host';

@Directive({
    selector: 'button[appWebVideoRemotePlayback]',
    exportAs: 'webVideoRemotePlayback',
})
export class WebVideoRemotePlaybackButtonDirective {
    readonly remotePlaybackSurface = input<HTMLElement | null>(null);
    readonly remotePlaybackSource = input<string | null>(null);
    readonly remotePlaybackHost = input<unknown>(null);
    readonly controller = new WebVideoRemotePlaybackController();
    readonly state = this.controller.state;

    constructor() {
        effect((onCleanup) => {
            const surface = this.remotePlaybackSurface();
            const source = this.remotePlaybackSource();
            const candidateHost = this.remotePlaybackHost();
            const host: WebVideoRemotePlaybackHost | null =
                isWebVideoRemotePlaybackHost(candidateHost)
                    ? candidateHost
                    : null;
            const attach = () => {
                const video = surface?.querySelector('video') ?? null;
                if (video) this.controller.attach(video, source, host);
                return Boolean(video);
            };
            const attached = untracked(attach);
            let observer: MutationObserver | null = null;
            if (
                !attached &&
                surface &&
                typeof MutationObserver !== 'undefined'
            ) {
                observer = new MutationObserver(() => {
                    if (attach()) observer?.disconnect();
                });
            }
            observer?.observe(surface as Node, {
                childList: true,
                subtree: true,
            });
            onCleanup(() => {
                observer?.disconnect();
                this.controller.detach();
            });
        });
    }

    prompt(): void {
        this.controller.prompt();
    }
}
