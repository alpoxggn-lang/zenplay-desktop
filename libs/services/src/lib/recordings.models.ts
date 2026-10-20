import type { ElectronRecordingItem } from '@iptvnator/shared/interfaces';

/**
 * Renderer-facing live-TV recording row. The bridge type is already
 * camelCased and carries the decoded `programs` array plus the derived
 * `fileAvailability`, so the renderer model is a direct alias.
 */
export type RecordingItem = ElectronRecordingItem & {
    /** Browser-tab lease used only by PWA MediaRecorder sessions. */
    browserOwnerId?: string;
    browserLeaseUntil?: number;
    /** Short-lived compare-and-swap claim while an OPFS removal is in flight. */
    browserRemovalToken?: string;
    browserRemovalStartedAt?: number;
    /** Actual MediaRecorder output type for private PWA recordings. */
    browserMimeType?: string;
    /** Ephemeral ownership hint; never persisted by the browser manager. */
    browserOwnedByThisTab?: boolean;
};

export interface BrowserRecordingSnapshot {
    readonly active: boolean;
    readonly elapsedSeconds: number;
    readonly message: string | null;
    readonly transitionKey: string | null;
    readonly owner: HTMLVideoElement | null;
}

export type {
    RecordingProgramSnapshot,
    RecordingSourceType,
    RecordingStatus,
} from '@iptvnator/shared/interfaces';
