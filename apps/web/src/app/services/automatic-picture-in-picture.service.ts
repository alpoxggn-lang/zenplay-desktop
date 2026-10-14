import { Injectable, OnDestroy } from '@angular/core';

const ENTER_PICTURE_IN_PICTURE_ACTION = 'enterpictureinpicture' as const;
const VIDEO_RELEASE_EVENTS = ['pause', 'ended', 'emptied', 'error'] as const;

type PictureInPictureActionHandler = () => void;

type PictureInPictureMediaSession = {
    setActionHandler(
        action: typeof ENTER_PICTURE_IN_PICTURE_ACTION,
        handler: PictureInPictureActionHandler | null
    ): void;
};

type PictureInPictureNavigator = Navigator & {
    mediaSession?: PictureInPictureMediaSession;
};

type PictureInPictureDocument = Document & {
    pictureInPictureElement?: Element | null;
    pictureInPictureEnabled?: boolean;
};

type PictureInPictureVideo = HTMLVideoElement & {
    requestPictureInPicture?: () => Promise<PictureInPictureWindow>;
};

interface MediaSessionActionOwner {
    readonly token: symbol;
    readonly handler: PictureInPictureActionHandler;
}

const mediaSessionActionOwners = new WeakMap<
    PictureInPictureMediaSession,
    MediaSessionActionOwner[]
>();

/**
 * Claims the Media Session PiP action without letting an older owner clear a
 * newer one during teardown. Known owners are restored in stack order.
 */
function claimPictureInPictureAction(
    mediaSession: PictureInPictureMediaSession,
    handler: PictureInPictureActionHandler
): (() => void) | null {
    const owner: MediaSessionActionOwner = { token: Symbol(), handler };
    const owners = mediaSessionActionOwners.get(mediaSession) ?? [];

    try {
        mediaSession.setActionHandler(ENTER_PICTURE_IN_PICTURE_ACTION, handler);
    } catch {
        // Older browsers throw for action names they do not implement.
        return null;
    }

    owners.push(owner);
    mediaSessionActionOwners.set(mediaSession, owners);

    return () => {
        const currentOwners = mediaSessionActionOwners.get(mediaSession);
        const index = currentOwners?.findIndex(
            (candidate) => candidate.token === owner.token
        );
        if (!currentOwners || index === undefined || index < 0) {
            return;
        }

        const wasCurrentOwner = index === currentOwners.length - 1;
        currentOwners.splice(index, 1);
        if (!wasCurrentOwner) {
            return;
        }

        const previousOwner = currentOwners[currentOwners.length - 1];
        try {
            mediaSession.setActionHandler(
                ENTER_PICTURE_IN_PICTURE_ACTION,
                previousOwner?.handler ?? null
            );
        } catch {
            // The action may disappear while a browser session is shutting down.
        }

        if (currentOwners.length === 0) {
            mediaSessionActionOwners.delete(mediaSession);
        }
    };
}

/**
 * Lets the browser/OS move active web playback into standard element PiP when
 * it emits the Media Session `enterpictureinpicture` action. This deliberately
 * does not request PiP from `visibilitychange`: browsers require user/system
 * activation for the request and iOS may choose not to expose that action.
 */
@Injectable({ providedIn: 'root' })
export class AutomaticPictureInPictureService implements OnDestroy {
    private started = false;
    private readonly playingVideos = new Set<HTMLVideoElement>();
    private readonly releaseCleanups = new Map<HTMLVideoElement, () => void>();
    private releaseMediaSessionAction: (() => void) | null = null;

    private readonly onPlaying = (event: Event) => {
        const target = event.target;
        if (target instanceof HTMLVideoElement) {
            this.trackAsMostRecent(target);
        }
    };

    private readonly onEnterPictureInPicture = () => {
        const video = this.mostRecentPlayingVideo();
        if (!video) {
            return;
        }

        const pictureInPictureVideo = video as PictureInPictureVideo;
        const ownerDocument = video.ownerDocument as PictureInPictureDocument;
        if (
            ownerDocument.pictureInPictureElement === video ||
            ownerDocument.pictureInPictureElement != null ||
            ownerDocument.pictureInPictureEnabled === false ||
            video.disablePictureInPicture ||
            video.readyState < HTMLMediaElement.HAVE_METADATA ||
            typeof pictureInPictureVideo.requestPictureInPicture !== 'function'
        ) {
            return;
        }

        try {
            void pictureInPictureVideo.requestPictureInPicture().catch(() => {
                // The platform can still deny PiP after offering the action.
            });
        } catch {
            // Some implementations reject synchronously when activation ends.
        }
    };

    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;

        const mediaSession = (navigator as PictureInPictureNavigator)
            .mediaSession;
        if (!mediaSession?.setActionHandler) {
            return;
        }

        this.releaseMediaSessionAction = claimPictureInPictureAction(
            mediaSession,
            this.onEnterPictureInPicture
        );
        if (!this.releaseMediaSessionAction) {
            return;
        }

        document.addEventListener('playing', this.onPlaying, true);
    }

    stop(): void {
        if (!this.started) {
            return;
        }
        this.started = false;
        document.removeEventListener('playing', this.onPlaying, true);

        for (const cleanup of this.releaseCleanups.values()) {
            cleanup();
        }
        this.releaseCleanups.clear();
        this.playingVideos.clear();

        this.releaseMediaSessionAction?.();
        this.releaseMediaSessionAction = null;
    }

    ngOnDestroy(): void {
        this.stop();
    }

    private trackAsMostRecent(video: HTMLVideoElement): void {
        // A detached media element normally emits pause, but do not rely on
        // every engine/browser doing so during a source or Tech replacement.
        // Prune stale owners whenever another playback becomes active.
        for (const candidate of [...this.playingVideos]) {
            if (!candidate.isConnected || candidate.paused || candidate.ended) {
                this.untrack(candidate);
            }
        }

        if (!this.releaseCleanups.has(video)) {
            const onRelease = () => this.untrack(video);
            for (const eventType of VIDEO_RELEASE_EVENTS) {
                video.addEventListener(eventType, onRelease);
            }
            this.releaseCleanups.set(video, () => {
                for (const eventType of VIDEO_RELEASE_EVENTS) {
                    video.removeEventListener(eventType, onRelease);
                }
            });
        }

        this.playingVideos.delete(video);
        this.playingVideos.add(video);
    }

    private untrack(video: HTMLVideoElement): void {
        this.playingVideos.delete(video);
        this.releaseCleanups.get(video)?.();
        this.releaseCleanups.delete(video);
    }

    private mostRecentPlayingVideo(): HTMLVideoElement | null {
        const candidates = [...this.playingVideos];
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
            const video = candidates[index];
            if (!video.isConnected || video.paused || video.ended) {
                this.untrack(video);
                continue;
            }
            return video;
        }
        return null;
    }
}
