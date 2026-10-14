export const MAX_HLS_MANIFEST_BYTES = 2 * 1024 * 1024;

const HLS_CONTENT_TYPES = new Set([
    'application/vnd.apple.mpegurl',
    'application/x-mpegurl',
    'audio/mpegurl',
    'audio/x-mpegurl',
]);

export function isHlsManifest(
    contentType: string | undefined,
    url: URL
): boolean {
    const normalizedType = contentType?.split(';', 1)[0].trim().toLowerCase();
    return (
        (normalizedType ? HLS_CONTENT_TYPES.has(normalizedType) : false) ||
        url.pathname.toLowerCase().endsWith('.m3u8')
    );
}

/** Replaces every fetchable HLS URI with an opaque same-origin resource. */
export function rewriteHlsManifest(options: {
    readonly body: string;
    readonly manifestUrl: URL;
    readonly resourcePath: (url: URL) => string;
}): string {
    const trailingNewline = /\r?\n$/.test(options.body);
    const lines = options.body.replace(/^\uFEFF/, '').split(/\r?\n/);
    const rewritten = lines.map((line) => {
        if (!line) return line;
        if (!line.startsWith('#')) {
            return options.resourcePath(
                resolveHttpUri(line, options.manifestUrl)
            );
        }
        return line.replace(
            /URI=(?:"([^"]*)"|([^,\s]*))/g,
            (
                _match,
                quoted: string | undefined,
                unquoted: string | undefined
            ) => {
                const path = options.resourcePath(
                    resolveHttpUri(
                        quoted ?? unquoted ?? '',
                        options.manifestUrl
                    )
                );
                return `URI="${path}"`;
            }
        );
    });
    if (trailingNewline && rewritten.at(-1) !== '') rewritten.push('');
    return rewritten.join('\n');
}

function resolveHttpUri(value: string, manifestUrl: URL): URL {
    let resolved: URL;
    try {
        resolved = new URL(value.trim(), manifestUrl);
    } catch {
        throw new Error('HLS manifest contains an invalid URI');
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        throw new Error('HLS manifest contains an unsupported URI');
    }
    resolved.hash = '';
    return resolved;
}
