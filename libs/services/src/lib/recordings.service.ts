import { computed, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type {
    ElectronBridgeErrorResult,
    RecordingProgramSnapshot,
} from '@iptvnator/shared/interfaces';
import { DownloadListLoadState } from './download-list-load-state';
import type { RecordingItem } from './recordings.models';
import { RuntimeCapabilitiesService } from './runtime-capabilities.service';
import { browserMediaLibrary } from './browser-media-library';
import { BROWSER_MEDIA_MESSAGES } from './browser-media-library/browser-media-messages';

export type { RecordingItem } from './recordings.models';

const BROWSER_RECORDING_POLL_MS = 15_000;

/**
 * Global store for live-TV recordings, mirroring DownloadsService: one
 * authoritative list refreshed on RECORDINGS_UPDATE_EVENT pings, with
 * overlapping loads coalesced behind one serialized trailing refresh.
 */
@Injectable({ providedIn: 'root' })
export class RecordingsService implements OnDestroy {
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly translate = inject(TranslateService, { optional: true });
    private unsubscribe?: () => void;
    private browserPollId?: number;
    private destroyed = false;
    private readonly listLoadState = new DownloadListLoadState();

    readonly recordings = signal<RecordingItem[]>([]);
    readonly isLoadingRecordings = this.listLoadState.isLoading;
    readonly hasLoadedRecordings = this.listLoadState.hasLoaded;
    readonly hasAuthoritativeRecordingList =
        this.listLoadState.hasAuthoritativeList;

    /** Whether recordings are available through Electron or the browser recorder. */
    readonly isAvailable = computed(() => this.runtime.supportsRecordings);

    readonly hasRecordings = computed(() => this.recordings().length > 0);

    /** The recording currently in progress, if any. */
    readonly activeRecording = computed(
        () => this.recordings().find((r) => r.status === 'recording') ?? null
    );

    constructor() {
        this.init();
    }

    private async init() {
        if (!this.isAvailable()) {
            return;
        }

        if (this.usesBrowserMediaLibrary) {
            this.unsubscribe = browserMediaLibrary.subscribe((kind) => {
                if (kind === 'recordings') void this.loadRecordings();
            });
            await browserMediaLibrary.initialize();
            await this.loadRecordings();
            if (!this.destroyed) {
                this.browserPollId = window.setInterval(
                    () => void this.loadRecordings(),
                    BROWSER_RECORDING_POLL_MS
                );
            }
            return;
        }

        // Subscribe BEFORE the initial load: a recording transition during
        // that request pings while the response still reflects the older
        // database state, and the load-state coalescing can only queue the
        // trailing refresh if the listener already exists.
        this.unsubscribe = window.electron.onRecordingsUpdate?.(() => {
            this.loadRecordings();
        });
        await this.loadRecordings();
    }

    ngOnDestroy() {
        this.destroyed = true;
        if (this.browserPollId !== undefined) {
            window.clearInterval(this.browserPollId);
        }
        this.unsubscribe?.();
    }

    async loadRecordings(): Promise<void> {
        if (!this.isAvailable()) return;

        return this.listLoadState.run(async () => {
            try {
                const list = this.usesBrowserMediaLibrary
                    ? await browserMediaLibrary.listRecordings()
                    : await window.electron.recordingsGetList?.();
                this.recordings.set(list ?? []);
                this.listLoadState.markSucceeded();
            } catch (error) {
                console.error(
                    '[RecordingsService] Error loading recordings:',
                    error
                );
                this.listLoadState.markFailed();
            }
        });
    }

    async getRecording(recordingId: number): Promise<RecordingItem | null> {
        if (!this.isAvailable()) return null;
        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.getRecording(recordingId);
        }
        try {
            return (await window.electron.recordingsGet?.(recordingId)) ?? null;
        } catch (error) {
            console.error(
                '[RecordingsService] Error getting recording:',
                error
            );
            return null;
        }
    }

    async stopRecording(
        recordingId: number
    ): Promise<ElectronBridgeErrorResult> {
        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.stopRecording(recordingId);
        }
        return this.runAction('stop', () =>
            window.electron.recordingsStop?.(recordingId)
        );
    }

    async removeRecording(
        recordingId: number
    ): Promise<ElectronBridgeErrorResult> {
        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.removeRecording(recordingId);
        }
        return this.runAction(
            'remove',
            () => window.electron.recordingsRemove?.(recordingId),
            // The ping fires from the backend too, but refreshing directly
            // keeps the UI honest if the broadcast is missed.
            true
        );
    }

    async updatePrograms(
        targetPath: string,
        programs: RecordingProgramSnapshot[]
    ): Promise<ElectronBridgeErrorResult> {
        if (this.usesBrowserMediaLibrary) {
            return browserMediaLibrary.updateRecordingPrograms(
                targetPath,
                programs
            );
        }
        return this.runAction('update programs', () =>
            window.electron.recordingsUpdatePrograms?.(targetPath, programs)
        );
    }

    async revealFile(filePath: string): Promise<ElectronBridgeErrorResult> {
        if (this.usesBrowserMediaLibrary) {
            return {
                success: false,
                error: BROWSER_MEDIA_MESSAGES.privateStorageOnly,
            };
        }
        return this.runAction('reveal', () =>
            window.electron.recordingsRevealFile?.(filePath)
        );
    }

    async playFile(filePath: string): Promise<ElectronBridgeErrorResult> {
        if (this.usesBrowserMediaLibrary) {
            const item = this.recordings().find(
                ({ filePath: path }) => path === filePath
            );
            return browserMediaLibrary.playPrivateFile(
                filePath,
                item?.channelName ?? 'ZenPlay',
                this.translate?.instant('CLOSE') ?? 'CLOSE'
            );
        }
        return this.runAction('play', () =>
            window.electron.recordingsPlayFile?.(filePath)
        );
    }

    private async runAction(
        label: string,
        action: () => Promise<ElectronBridgeErrorResult> | undefined,
        refreshAfter = false
    ): Promise<ElectronBridgeErrorResult> {
        if (!this.isAvailable()) {
            return { error: 'Recordings are not available', success: false };
        }
        try {
            const result = (await action()) ?? {
                error: 'Recordings bridge unavailable',
                success: false,
            };
            if (refreshAfter && result.success) {
                await this.loadRecordings();
            }
            return result;
        } catch (error) {
            console.error(`[RecordingsService] Error (${label}):`, error);
            return {
                error: error instanceof Error ? error.message : String(error),
                success: false,
            };
        }
    }

    /** Kept defensive for prototype-only unit harnesses used by this service. */
    private get usesBrowserMediaLibrary(): boolean {
        return this.runtime?.isPwa === true;
    }
}
