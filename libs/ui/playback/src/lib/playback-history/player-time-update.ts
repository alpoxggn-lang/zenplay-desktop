/** Position report an engine emits on every media time update. */
export interface PlayerTimeUpdate {
    readonly currentTime: number;
    readonly duration: number;
    /**
     * Whether `duration` is the final media duration. Append-only EVENT HLS
     * playlists expose only the part generated so far, so treating that value
     * as final can mark a title watched while it is still being prepared.
     * Undefined keeps the historical behaviour for ordinary media engines.
     */
    readonly durationFinal?: boolean;
    /**
     * Whether the media was actually playing — not paused and not seeking.
     * Seeks of paused media also move the position; only playing reports
     * count towards the "really played" history confirmation. Left undefined
     * by an engine that cannot tell.
     */
    readonly playing?: boolean;
}
