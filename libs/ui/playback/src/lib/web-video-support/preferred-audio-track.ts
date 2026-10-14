export interface PreferredAudioTrackCandidate {
    readonly characteristics?: unknown;
    readonly kind?: unknown;
    readonly label?: unknown;
    readonly language?: unknown;
    readonly lang?: unknown;
    readonly name?: unknown;
    readonly roles?: unknown;
}

const SPANISH_LANGUAGE_CODES = new Set(['es', 'spa', 'esp']);
const SPANISH_LABEL_TOKENS = new Set([
    'castellano',
    'castilian',
    'espanol',
    'latam',
    'latino',
    'latina',
    'spa',
    'spanish',
]);

/** Returns the first explicitly Spanish audio track, or `-1` when none says so. */
export function findPreferredSpanishAudioTrackIndex(
    tracks: readonly PreferredAudioTrackCandidate[] | null | undefined
): number {
    if (!tracks) {
        return -1;
    }

    const spanishIndexes: number[] = [];
    tracks.forEach((track, index) => {
        if (isSpanishTrack(track)) {
            spanishIndexes.push(index);
        }
    });
    return (
        spanishIndexes.find(
            (index) => !isCommentaryOrDescribedAudio(tracks[index])
        ) ??
        spanishIndexes[0] ??
        -1
    );
}

function isSpanishTrack(track: PreferredAudioTrackCandidate): boolean {
    return (
        isSpanishLanguage(track?.language) ||
        isSpanishLanguage(track?.lang) ||
        isSpanishLabel(track?.label) ||
        isSpanishLabel(track?.name)
    );
}

function isCommentaryOrDescribedAudio(
    track: PreferredAudioTrackCandidate
): boolean {
    const descriptors = [
        track.kind,
        track.label,
        track.name,
        track.roles,
        track.characteristics,
    ];
    const values: unknown[] = [];
    for (const descriptor of descriptors) {
        if (Array.isArray(descriptor)) {
            values.push(...descriptor);
        } else {
            values.push(descriptor);
        }
    }
    const text = values.map(normalizeAudioLanguage).filter(Boolean).join(' ');
    if (!text) {
        return false;
    }
    const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
    if (
        [
            'comment',
            'commentaries',
            'commentary',
            'comments',
            'comentario',
            'comentarios',
        ].some((token) => tokens.has(token))
    ) {
        return true;
    }
    return (
        tokens.has('descriptions') ||
        tokens.has('audiodescription') ||
        tokens.has('audiodescripcion') ||
        text.includes('audio description') ||
        text.includes('audio descripcion') ||
        text.includes('descripcion de audio') ||
        text.includes('descriptive audio')
    );
}

function isSpanishLanguage(value: unknown): boolean {
    const normalized = normalizeAudioLanguage(value);
    if (!normalized) {
        return false;
    }
    const primary = normalized.split('-', 1)[0];
    return (
        SPANISH_LANGUAGE_CODES.has(primary) || hasSpanishLabelToken(normalized)
    );
}

function isSpanishLabel(value: unknown): boolean {
    const normalized = normalizeAudioLanguage(value);
    return !!normalized && hasSpanishLabelToken(normalized);
}

function hasSpanishLabelToken(value: string): boolean {
    return value
        .split(/[^a-z0-9]+/)
        .some((token) => SPANISH_LABEL_TOKENS.has(token));
}

function normalizeAudioLanguage(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-');
}
