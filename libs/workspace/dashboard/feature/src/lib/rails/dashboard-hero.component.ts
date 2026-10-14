import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    input,
    linkedSignal,
    signal,
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { MetaChipComponent } from '@iptvnator/ui/components';
import { DashboardHeroSlidesPresenter } from './dashboard-hero-slides.presenter';
import {
    HERO_ROTATION_MS,
    type DashboardHeroMode,
} from './dashboard-hero-slides.utils';
import type { DashboardHeroSlide } from './dashboard-hero.utils';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const HERO_POINTER_SWIPE_THRESHOLD_PX = 48;
const HERO_WHEEL_SWIPE_THRESHOLD_PX = 56;
const HERO_WHEEL_IDLE_MS = 220;

/**
 * Cinematic dashboard hero: a full-bleed backdrop that rotates between an
 * unfinished title, a favourite channel on air now and a few discovery
 * picks (see `pickDashboardHeroSources`).
 *
 * Rotation is driven by the active indicator's CSS fill animation: its
 * `animationend` advances the slide, so pausing (hover, focus inside the
 * hero, pointer or trackpad interaction) is just
 * `animation-play-state: paused` and resumes where it stopped. With
 * `prefers-reduced-motion` there is no animation and therefore no
 * auto-advance; keyboard and swipe navigation still work.
 *
 * The active slide is tracked by id, so a slide that arrives late (the live
 * slide waits for its EPG answer) never yanks the user off the current one.
 * Every slide is laid out and only the active one is shown, so the hero is
 * as tall as its tallest slide and a rotation never resizes it.
 *
 * The hero is a focusable region: ←/→ switch slides, Enter follows the
 * primary action. Rotation also pauses while the document is hidden.
 */
@Component({
    selector: 'lib-dashboard-hero',
    imports: [MatIcon, MetaChipComponent, RouterLink, TranslatePipe],
    templateUrl: './dashboard-hero.component.html',
    styleUrl: './dashboard-hero.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    providers: [DashboardHeroSlidesPresenter],
    host: {
        '[style.--hero-rotation-ms]': 'rotationMs + "ms"',
    },
})
export class DashboardHeroComponent {
    readonly presenter = inject(DashboardHeroSlidesPresenter);
    private readonly destroyRef = inject(DestroyRef);
    readonly mode = input<DashboardHeroMode>('personalized');
    readonly slides = this.presenter.slides;
    readonly rotationMs = HERO_ROTATION_MS;

    /**
     * The slide on screen, by id. Pinned to the first slide as soon as one
     * exists, so a late slide inserted ahead of it cannot take its place;
     * if the active slide itself disappears, the one now at its position
     * takes over.
     */
    private readonly activeId = linkedSignal<
        DashboardHeroSlide[],
        string | null
    >({
        source: this.slides,
        computation: (slides, previous) => {
            const currentId = previous?.value ?? null;
            if (currentId && slides.some((slide) => slide.id === currentId)) {
                return currentId;
            }
            const previousIndex =
                previous?.source.findIndex((slide) => slide.id === currentId) ??
                -1;
            const index = Math.min(
                Math.max(previousIndex, 0),
                slides.length - 1
            );
            return slides[index]?.id ?? null;
        },
    });
    private readonly hovered = signal(false);
    private readonly focusWithin = signal(false);
    private readonly interacting = signal(false);
    private readonly documentHidden = signal(false);
    readonly reducedMotion = signal(false);
    private pointerGesture: {
        id: number;
        startX: number;
        startY: number;
        navigated: boolean;
    } | null = null;
    private wheelDistance = 0;
    private wheelNavigated = false;
    private wheelIdleTimer: ReturnType<typeof setTimeout> | null = null;

    readonly activeIndex = computed(() => {
        const index = this.slides().findIndex(
            (slide) => slide.id === this.activeId()
        );
        return index >= 0 ? index : 0;
    });

    readonly activeSlide = computed(
        () => this.slides()[this.activeIndex()] ?? null
    );

    readonly canRotate = computed(
        () => this.slides().length > 1 && !this.reducedMotion()
    );

    readonly paused = computed(
        () =>
            this.hovered() ||
            this.focusWithin() ||
            this.interacting() ||
            this.documentHidden()
    );

    constructor() {
        effect(() => this.presenter.setMode(this.mode()));

        if (typeof document !== 'undefined') {
            const onVisibility = () =>
                this.documentHidden.set(document.visibilityState === 'hidden');
            onVisibility();
            document.addEventListener('visibilitychange', onVisibility);
            this.destroyRef.onDestroy(() =>
                document.removeEventListener('visibilitychange', onVisibility)
            );
        }
        const media =
            typeof window !== 'undefined' && window.matchMedia
                ? window.matchMedia(REDUCED_MOTION_QUERY)
                : null;
        if (media) {
            this.reducedMotion.set(media.matches);
            const onChange = (event: MediaQueryListEvent) =>
                this.reducedMotion.set(event.matches);
            media.addEventListener('change', onChange);
            this.destroyRef.onDestroy(() =>
                media.removeEventListener('change', onChange)
            );
        }
        this.destroyRef.onDestroy(() => {
            if (this.wheelIdleTimer !== null) {
                clearTimeout(this.wheelIdleTimer);
            }
        });
    }

    show(index: number): void {
        const slide = this.slides()[index];
        if (slide) {
            this.activeId.set(slide.id);
        }
    }

    /** The active indicator's fill animation finished: show the next slide. */
    onRotationTick(): void {
        if (!this.canRotate() || this.paused()) {
            return;
        }
        this.show((this.activeIndex() + 1) % this.slides().length);
    }

    setHovered(hovered: boolean): void {
        this.hovered.set(hovered);
    }

    onFocusIn(): void {
        this.focusWithin.set(true);
    }

    onFocusOut(event: FocusEvent): void {
        const host = event.currentTarget as HTMLElement | null;
        const next = event.relatedTarget as Node | null;
        if (!host || !next || !host.contains(next)) {
            this.focusWithin.set(false);
        }
    }

    onPointerDown(event: PointerEvent): void {
        if (
            !event.isPrimary ||
            this.slides().length < 2 ||
            this.isInteractiveTarget(event.target)
        ) {
            return;
        }
        this.pointerGesture = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            navigated: false,
        };
        (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(
            event.pointerId
        );
        this.interacting.set(true);
    }

    onPointerMove(event: PointerEvent): void {
        const gesture = this.pointerGesture;
        if (!gesture || gesture.id !== event.pointerId || gesture.navigated) {
            return;
        }

        const deltaX = event.clientX - gesture.startX;
        const deltaY = event.clientY - gesture.startY;
        if (
            Math.abs(deltaX) < HERO_POINTER_SWIPE_THRESHOLD_PX ||
            Math.abs(deltaX) <= Math.abs(deltaY)
        ) {
            return;
        }

        event.preventDefault();
        gesture.navigated = true;
        this.move(deltaX < 0 ? 1 : -1);
    }

    onPointerEnd(event: PointerEvent): void {
        if (this.pointerGesture?.id !== event.pointerId) {
            return;
        }
        this.pointerGesture = null;
        this.interacting.set(false);
        const host = event.currentTarget as HTMLElement | null;
        if (host?.hasPointerCapture?.(event.pointerId)) {
            host.releasePointerCapture(event.pointerId);
        }
    }

    onHeroWheel(event: WheelEvent): void {
        if (this.slides().length < 2) {
            return;
        }

        const horizontalDelta = event.shiftKey ? event.deltaY : event.deltaX;
        const verticalDelta = event.shiftKey ? 0 : event.deltaY;
        if (
            Math.abs(horizontalDelta) <= Math.abs(verticalDelta) ||
            horizontalDelta === 0
        ) {
            return;
        }

        event.preventDefault();
        this.interacting.set(true);
        this.wheelDistance += horizontalDelta;
        if (
            !this.wheelNavigated &&
            Math.abs(this.wheelDistance) >= HERO_WHEEL_SWIPE_THRESHOLD_PX
        ) {
            this.wheelNavigated = true;
            this.move(this.wheelDistance > 0 ? 1 : -1);
        }

        if (this.wheelIdleTimer !== null) {
            clearTimeout(this.wheelIdleTimer);
        }
        this.wheelIdleTimer = setTimeout(() => {
            this.wheelDistance = 0;
            this.wheelNavigated = false;
            this.wheelIdleTimer = null;
            this.interacting.set(false);
        }, HERO_WHEEL_IDLE_MS);
    }

    /**
     * On the hero region itself: ←/→ switch slides, Enter follows the
     * primary action. Buttons and dots inside keep their own keys.
     */
    onHeroKeydown(event: KeyboardEvent): void {
        if (event.target !== event.currentTarget) {
            return;
        }
        const count = this.slides().length;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            if (count < 2) {
                return;
            }
            event.preventDefault();
            const step = event.key === 'ArrowRight' ? 1 : -1;
            this.show((this.activeIndex() + step + count) % count);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            // Every slide is in the DOM; the inactive ones are inert.
            (event.currentTarget as HTMLElement)
                .querySelector<HTMLElement>(
                    '.hero__content:not([inert]) .hero__button--primary'
                )
                ?.click();
        }
    }

    private move(step: -1 | 1): void {
        const count = this.slides().length;
        if (count < 2) {
            return;
        }
        this.show((this.activeIndex() + step + count) % count);
    }

    private isInteractiveTarget(target: EventTarget | null): boolean {
        return (
            target instanceof Element &&
            target.closest('a, button, input, select, textarea') !== null
        );
    }
}
