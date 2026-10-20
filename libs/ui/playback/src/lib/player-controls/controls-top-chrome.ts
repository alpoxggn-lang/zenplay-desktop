import { computed, type Signal } from '@angular/core';
import type {
    PlayerControlsCapabilities,
    PlayerMediaTitle,
} from './player-controls.model';

/** Derives the shared fullscreen title/scrim state outside the host component. */
export function createControlsTopChrome(
    showControls: Signal<boolean>,
    isFullscreen: Signal<boolean>,
    mediaTitle: Signal<PlayerMediaTitle | null>,
    capabilities: Signal<PlayerControlsCapabilities>
) {
    const fullscreenMediaTitle = computed<PlayerMediaTitle | null>(() => {
        if (!showControls() || !isFullscreen()) {
            return null;
        }
        const title = mediaTitle();
        return title?.primary?.trim() ? title : null;
    });

    return {
        fullscreenMediaTitle,
        showTopScrim: computed(
            () =>
                showControls() &&
                (capabilities().streamStats ||
                    fullscreenMediaTitle() !== null)
        ),
    };
}
