interface BrowserStorageManager {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}

interface CapturableMediaElement extends HTMLMediaElement {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
}

function storageManager(): BrowserStorageManager | undefined {
    return typeof navigator === 'undefined'
        ? undefined
        : (navigator.storage as BrowserStorageManager | undefined);
}

export function supportsBrowserPrivateMediaStorage(): boolean {
    return (
        typeof window !== 'undefined' &&
        !window.electron &&
        typeof indexedDB !== 'undefined' &&
        typeof storageManager()?.getDirectory === 'function'
    );
}

export function supportsBrowserLiveRecording(): boolean {
    if (
        !supportsBrowserPrivateMediaStorage() ||
        typeof MediaRecorder === 'undefined'
    ) {
        return false;
    }
    const prototype = globalThis.HTMLMediaElement?.prototype as
        CapturableMediaElement | undefined;
    return (
        typeof prototype?.captureStream === 'function' ||
        typeof prototype?.mozCaptureStream === 'function'
    );
}

/**
 * Turns provider URLs into ZenPlay's opaque, session-authenticated media route.
 * The browser library never persists usernames, passwords, or the provider host.
 */
export function resolvePrivateBrowserMediaUrl(rawUrl: string): string | null {
    if (typeof window === 'undefined') return null;
    let parsed: URL;
    try {
        parsed = new URL(rawUrl, window.location.origin);
    } catch {
        return null;
    }

    const configuredBackend =
        window.__IPTVNATOR_CONFIG__?.BACKEND_URL?.trim() || '/api';
    let backend: URL;
    try {
        backend = new URL(configuredBackend, window.location.origin);
    } catch {
        return null;
    }

    const backendPath = backend.pathname.replace(/\/+$/u, '');
    const opaquePath =
        parsed.origin === backend.origin &&
        (backendPath === '' ||
            parsed.pathname === backendPath ||
            parsed.pathname.startsWith(`${backendPath}/`))
            ? parsed.pathname.slice(backendPath.length)
            : null;
    const opaqueMatch = opaquePath
        ? /^\/media\/(movie|series)\/(\d{1,16})\.([a-z0-9]{1,12})$/iu.exec(
              opaquePath
          )
        : null;
    if (
        opaqueMatch &&
        (parsed.origin === window.location.origin ||
            parsed.origin === backend.origin)
    ) {
        const base = configuredBackend.replace(/\/+$/u, '');
        return `${base}/media/${opaqueMatch[1].toLowerCase()}/${opaqueMatch[2]}.${opaqueMatch[3].toLowerCase()}`;
    }

    const providerMatch =
        /\/(movie|series)\/.+\/(\d{1,16})\.([a-z0-9]{1,12})$/iu.exec(
            parsed.pathname
        );
    if (!providerMatch) return null;
    const base = configuredBackend.replace(/\/+$/u, '');
    return `${base}/media/${providerMatch[1].toLowerCase()}/${providerMatch[2]}.${providerMatch[3].toLowerCase()}`;
}

/** A partial response is append-safe only when it starts at the requested byte. */
export function responseMatchesRequestedRange(
    response: Pick<Response, 'headers' | 'status'>,
    offset: number
): boolean {
    if (response.status !== 206) return offset <= 0;
    const match = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/iu.exec(
        response.headers.get('content-range') ?? ''
    );
    return Number(match?.[1] ?? -1) === offset;
}
