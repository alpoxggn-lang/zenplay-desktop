import { DatabaseService } from './database-electron.service';

describe('DatabaseService browser guards', () => {
    const originalElectron = window.electron;
    let service: DatabaseService;
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
        Object.defineProperty(window, 'electron', {
            configurable: true,
            writable: true,
            value: undefined,
        });
        consoleErrorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);

        service = new DatabaseService();
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        Object.defineProperty(window, 'electron', {
            configurable: true,
            writable: true,
            value: originalElectron,
        });
    });

    it('treats app state persistence as unavailable without the Electron bridge', async () => {
        await expect(service.getAppState('xtream-key')).resolves.toBeNull();
        await expect(
            service.setAppState('xtream-key', 'completed')
        ).resolves.toBe(false);
        await expect(
            service.getXtreamImportStatus('playlist-1', 'movie')
        ).resolves.toBe('idle');
        await expect(
            service.setXtreamImportStatus('playlist-1', 'movie', 'completed')
        ).resolves.toBe(false);
        await expect(
            service.getContentByXtreamId(20229, 'playlist-1', 'movie')
        ).resolves.toBeNull();
        await expect(service.getGlobalRecentlyViewed()).resolves.toEqual([]);
        await expect(service.getGlobalFavorites()).resolves.toEqual([]);
        await expect(service.getAllGlobalFavorites()).resolves.toEqual([]);
        await expect(
            service.clearGlobalRecentlyViewed()
        ).resolves.toBeUndefined();
        await expect(service.addToFavorites(20229, 'playlist-1')).resolves.toBe(
            false
        );
        await expect(
            service.removeFromFavorites(20229, 'playlist-1')
        ).resolves.toBe(false);
        await expect(service.isFavorite(20229, 'playlist-1')).resolves.toBe(
            false
        );
        await expect(service.getFavorites('playlist-1')).resolves.toEqual([]);
        await expect(service.getRecentItems('playlist-1')).resolves.toEqual([]);
        await expect(service.addRecentItem(20229, 'playlist-1')).resolves.toBe(
            false
        );
        await expect(
            service.clearPlaylistRecentItems('playlist-1')
        ).resolves.toBe(false);
        await expect(
            service.removeRecentItem(20229, 'playlist-1')
        ).resolves.toBe(false);
        await expect(
            service.removeRecentItemsBatch([
                { contentId: 20229, playlistId: 'playlist-1' },
            ])
        ).resolves.toBe(false);

        expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('preserves recently-added page failures for collection retry while keeping the dashboard fallback', async () => {
        const bridgeError = new Error('database unavailable');
        Object.defineProperty(window, 'electron', {
            configurable: true,
            writable: true,
            value: {
                dbGetGlobalRecentlyAdded: jest
                    .fn()
                    .mockRejectedValue(bridgeError),
            },
        });

        await expect(
            service.getGlobalRecentlyAddedPage('vod', 48, 'xtream', 0)
        ).rejects.toBe(bridgeError);
        await expect(
            service.getGlobalRecentlyAdded('vod', 48, 'xtream', 0)
        ).resolves.toEqual([]);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error getting global recently added items:',
            bridgeError
        );
    });
});
