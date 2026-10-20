import { appendRecordingChunk } from './browser-recording-file';
import type { BrowserPrivateStorage } from './browser-private-storage';

describe('appendRecordingChunk', () => {
    it('commits every chunk independently and preserves the last closed prefix', async () => {
        let committedSize = 0;
        let failNextWrite = false;
        const writers: Array<{
            abort: jest.Mock;
            close: jest.Mock;
            seek: jest.Mock;
            write: jest.Mock;
        }> = [];
        const handle = {
            getFile: jest.fn(async () => ({ size: committedSize }) as File),
            createWritable: jest.fn(async () => {
                let stagedSize = committedSize;
                let cursor = 0;
                const writer = {
                    abort: jest.fn().mockResolvedValue(undefined),
                    close: jest.fn(async () => {
                        committedSize = stagedSize;
                    }),
                    seek: jest.fn(async (offset: number) => {
                        cursor = offset;
                    }),
                    write: jest.fn(async (chunk: Blob) => {
                        if (failNextWrite) throw new Error('simulated crash');
                        stagedSize = Math.max(stagedSize, cursor + chunk.size);
                    }),
                };
                writers.push(writer);
                return writer;
            }),
        };
        const storage = {
            getFileHandle: jest.fn().mockResolvedValue(handle),
        } as unknown as BrowserPrivateStorage;

        await expect(
            appendRecordingChunk(
                storage,
                'opfs://recording',
                new Blob(['one']),
                0
            )
        ).resolves.toBe(3);
        failNextWrite = true;
        await expect(
            appendRecordingChunk(
                storage,
                'opfs://recording',
                new Blob(['lost']),
                3
            )
        ).rejects.toThrow('simulated crash');

        expect(committedSize).toBe(3);
        expect(handle.createWritable).toHaveBeenNthCalledWith(1, {
            keepExistingData: true,
        });
        expect(writers[0]?.seek).toHaveBeenCalledWith(0);
        expect(writers[0]?.close).toHaveBeenCalledTimes(1);
        expect(writers[1]?.abort).toHaveBeenCalledTimes(1);
    });
});
