import {
    ExternalPlayerArgumentsInput,
    parseExternalPlayerArguments,
} from './external-player-arguments.utils';

/**
 * One libmpv option destined for an embedded MPV session, as entered in
 * Settings > Playback: `key=value`, one per line, without the leading `--`.
 */
export interface EmbeddedMpvExtraOption {
    key: string;
    value: string;
}

/**
 * Options the embed itself depends on. A user value for any of these would
 * detach the video from the app window (`wid`, `vo`, `force-window`), break
 * the Linux IPC control channel (`input-ipc-server`), or defeat the session
 * lifecycle the addon relies on (`idle`, `keep-open`). `config`, `include`
 * and `terminal` are refused because the embedded player deliberately runs
 * with an isolated configuration and no terminal.
 */
export const EMBEDDED_MPV_FORBIDDEN_OPTION_KEYS: readonly string[] = [
    'wid',
    'vo',
    'force-window',
    'input-ipc-server',
    'idle',
    'keep-open',
    'config',
    'include',
    'terminal',
];

/**
 * Prefer the machine's native decoder without making playback depend on it.
 * `auto-safe` lets libmpv select a supported VideoToolbox/D3D11VA/VA-API
 * path and transparently fall back to software decoding when a driver or
 * codec cannot use hardware acceleration. A later user option can still
 * disable or replace this policy while troubleshooting a device.
 */
export const EMBEDDED_MPV_HARDWARE_DEFAULT_OPTIONS: readonly string[] = [
    'hwdec=auto-safe',
];

/**
 * Applied to every embedded session ahead of the user's options, on every
 * engine: a stalled IPTV connection surfaces as an mpv error within seconds
 * instead of the 60 s libmpv default, a bounded demuxer cache absorbs short
 * provider/network stalls without holding startup for a large prebuffer, and
 * ffmpeg re-requests a dropped HTTP stream before app-level reconnect. A user
 * line with the same key wins because it is applied later.
 */
export const EMBEDDED_MPV_NETWORK_DEFAULT_OPTIONS: readonly string[] = [
    'network-timeout=8',
    'cache=yes',
    'cache-pause-initial=no',
    'cache-secs=15',
    'demuxer-max-bytes=67108864',
    'demuxer-max-back-bytes=33554432',
    'demuxer-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=2',
];

/**
 * ZenPlay's browser engines prefer a provider-labelled Spanish audio track.
 * Give libmpv the equivalent language priority for direct desktop playback;
 * a later user option with the same key remains authoritative.
 */
export const EMBEDDED_MPV_LANGUAGE_DEFAULT_OPTIONS: readonly string[] = [
    'alang=es-419,es-MX,es-ES,es,spa,esp',
];

export interface EmbeddedMpvExtraOptionsValidationErrors {
    /** Lines that are not `key=value` with a non-empty value. */
    invalidLines?: string[];
    /** Keys from {@link EMBEDDED_MPV_FORBIDDEN_OPTION_KEYS} present in the text. */
    forbiddenKeys?: string[];
}

const OPTION_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

interface ParsedOptionLine {
    line: string;
    option: EmbeddedMpvExtraOption | null;
}

function parseOptionLine(line: string): ParsedOptionLine {
    const separator = line.indexOf('=');
    if (separator === -1) {
        return { line, option: null };
    }
    const key = line.slice(0, separator).trim().replace(/^--/, '');
    const value = line.slice(separator + 1).trim();
    if (!OPTION_KEY_PATTERN.test(key) || value.length === 0) {
        return { line, option: null };
    }
    return { line, option: { key, value } };
}

function parseOptionLines(
    value: ExternalPlayerArgumentsInput
): ParsedOptionLine[] {
    return parseExternalPlayerArguments(value).map(parseOptionLine);
}

/** The well-formed `key=value` pairs in the text; malformed lines are skipped. */
export function parseEmbeddedMpvExtraOptions(
    value: ExternalPlayerArgumentsInput
): EmbeddedMpvExtraOption[] {
    return parseOptionLines(value)
        .map((parsed) => parsed.option)
        .filter((option): option is EmbeddedMpvExtraOption => option !== null);
}

/**
 * Canonical text for storage: one trimmed line per option, `key=value`
 * without the `--` prefix. Malformed lines are kept verbatim rather than
 * dropped, so the user can still see and fix what the validator flagged.
 */
export function normalizeEmbeddedMpvExtraOptions(
    value: ExternalPlayerArgumentsInput
): string {
    return parseOptionLines(value)
        .map((parsed) =>
            parsed.option
                ? `${parsed.option.key}=${parsed.option.value}`
                : parsed.line
        )
        .join('\n');
}

/**
 * Validation for the Settings textarea: malformed lines and forbidden keys.
 * Returns `null` when the text is acceptable, so it plugs into an Angular
 * validator without this library depending on Angular.
 */
export function validateEmbeddedMpvExtraOptions(
    value: unknown
): EmbeddedMpvExtraOptionsValidationErrors | null {
    const parsedLines = parseOptionLines(
        typeof value === 'string' ? value : undefined
    );
    const invalidLines = parsedLines
        .filter((parsed) => parsed.option === null)
        .map((parsed) => parsed.line);
    const forbiddenKeys = [
        ...new Set(
            parsedLines
                .map((parsed) => parsed.option?.key)
                .filter(
                    (key): key is string =>
                        key !== undefined &&
                        EMBEDDED_MPV_FORBIDDEN_OPTION_KEYS.includes(key)
                )
        ),
    ];
    if (invalidLines.length === 0 && forbiddenKeys.length === 0) {
        return null;
    }
    return {
        ...(invalidLines.length > 0 ? { invalidLines } : {}),
        ...(forbiddenKeys.length > 0 ? { forbiddenKeys } : {}),
    };
}

/**
 * The `key=value` lines a session addon receives: hardware, network and
 * language defaults first, then trusted per-session defaults, then the user's
 * options with forbidden keys removed. Every engine (Windows/Linux/macOS
 * native-view and the frame-copy helper) applies them in this order after its
 * own built-in options, so an explicit user value remains authoritative.
 */
export function resolveEmbeddedMpvSessionOptionArguments(
    value: ExternalPlayerArgumentsInput,
    managedDefaults: readonly string[] = []
): string[] {
    const userOptions = parseEmbeddedMpvExtraOptions(value)
        .filter(
            (option) => !EMBEDDED_MPV_FORBIDDEN_OPTION_KEYS.includes(option.key)
        )
        .map((option) => `${option.key}=${option.value}`);
    return [
        ...EMBEDDED_MPV_HARDWARE_DEFAULT_OPTIONS,
        ...EMBEDDED_MPV_NETWORK_DEFAULT_OPTIONS,
        ...EMBEDDED_MPV_LANGUAGE_DEFAULT_OPTIONS,
        ...managedDefaults,
        ...userOptions,
    ];
}
