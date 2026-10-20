/** Keeps Remote Playback availability callbacks scoped to one attachment. */
export class WebVideoRemotePlaybackAvailability {
    private generation = 0;
    private remote: RemotePlayback | null = null;
    private watchId: number | null = null;

    watch(
        remote: RemotePlayback | null,
        onAvailability: (available: boolean) => void
    ): void {
        this.cancel();
        if (!remote || typeof remote.watchAvailability !== 'function') return;
        const generation = this.generation;
        this.remote = remote;
        void remote
            .watchAvailability((available) => {
                if (generation === this.generation && remote === this.remote) {
                    onAvailability(available);
                }
            })
            .then((id) => {
                if (generation !== this.generation || remote !== this.remote) {
                    void remote
                        .cancelWatchAvailability(id)
                        .catch(() => undefined);
                    return;
                }
                this.watchId = id;
            })
            .catch(() => undefined);
    }

    cancel(): void {
        this.generation += 1;
        const remote = this.remote;
        const watchId = this.watchId;
        this.remote = null;
        this.watchId = null;
        if (remote && watchId !== null) {
            void remote.cancelWatchAvailability(watchId).catch(() => undefined);
        }
    }
}
