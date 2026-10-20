function lockName(id: number): string {
    return `zenplay-download:${id}`;
}

export function supportsBrowserDownloadLocks(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.locks;
}

export async function withBrowserDownloadLock(
    id: number,
    ifAvailable: boolean,
    action: () => Promise<void>
): Promise<boolean> {
    if (!supportsBrowserDownloadLocks()) {
        await action();
        return true;
    }
    let acquired = false;
    await navigator.locks.request(
        lockName(id),
        { mode: 'exclusive', ifAvailable },
        async (lock) => {
            if (!lock) return;
            acquired = true;
            await action();
        }
    );
    return acquired;
}
