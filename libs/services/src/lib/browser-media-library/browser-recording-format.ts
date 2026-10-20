import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';

export function nextBrowserRecordingId(): number {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

export function selectBrowserRecordingMimeType(): string {
    for (const candidate of [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4;codecs=h264,aac',
        'video/mp4',
    ]) {
        if (MediaRecorder.isTypeSupported?.(candidate)) return candidate;
    }
    return '';
}

export function browserRecordingError(
    error: unknown,
    fallback: string = BROWSER_MEDIA_MESSAGES.recordingStartFailed
): string {
    return error instanceof Error ? error.message : fallback;
}
