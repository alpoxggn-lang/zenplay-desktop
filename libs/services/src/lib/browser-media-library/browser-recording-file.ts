import { BROWSER_MEDIA_MESSAGES } from './browser-media-messages';
import type { BrowserPrivateStorage } from './browser-private-storage';

async function abortQuietly(
    writable: FileSystemWritableFileStream
): Promise<void> {
    try {
        await writable.abort();
    } catch {
        // A failed write can leave the temporary OPFS writer already closed.
    }
}

/**
 * Appends one MediaRecorder chunk as its own OPFS transaction. OPFS only
 * publishes createWritable() changes on close, so every resolved call is a
 * crash-recoverable prefix rather than data held in one long-lived writer.
 */
export async function appendRecordingChunk(
    storage: BrowserPrivateStorage,
    filePath: string,
    chunk: Blob,
    expectedOffset: number
): Promise<number> {
    const handle = await storage.getFileHandle(filePath, false);
    const before = await handle.getFile();
    if (before.size !== expectedOffset) {
        throw new Error(BROWSER_MEDIA_MESSAGES.recordingOwnershipChanged);
    }

    const writable = await handle.createWritable({ keepExistingData: true });
    try {
        await writable.seek(expectedOffset);
        await writable.write(chunk);
        await writable.close();
    } catch (error) {
        await abortQuietly(writable);
        throw error;
    }

    const committedSize = (await handle.getFile()).size;
    if (committedSize !== expectedOffset + chunk.size) {
        throw new Error(BROWSER_MEDIA_MESSAGES.recordingSaveFailed);
    }
    return committedSize;
}
