import { WebVideoNativeAudioTracks } from './web-video-native-audio-tracks';

interface FakeAudioTrack {
    id?: string;
    label?: string;
    language?: string;
    enabled: boolean;
}

interface FakeAudioTrackList {
    length: number;
    [index: number]: FakeAudioTrack | undefined;
    addEventListener: jest.Mock;
    removeEventListener: jest.Mock;
    emit(type: string): void;
    replace(tracks: FakeAudioTrack[]): void;
}

function createTrackList(initial: FakeAudioTrack[]): FakeAudioTrackList {
    const listeners = new Map<string, Set<EventListener>>();
    const list = {
        length: 0,
        addEventListener: jest.fn((type: string, listener: EventListener) => {
            const entries = listeners.get(type) ?? new Set<EventListener>();
            entries.add(listener);
            listeners.set(type, entries);
        }),
        removeEventListener: jest.fn(
            (type: string, listener: EventListener) => {
                listeners.get(type)?.delete(listener);
            }
        ),
        emit(type: string) {
            for (const listener of listeners.get(type) ?? []) {
                listener(new Event(type));
            }
        },
        replace(tracks: FakeAudioTrack[]) {
            for (let index = 0; index < this.length; index += 1) {
                delete this[index];
            }
            tracks.forEach((track, index) => {
                this[index] = track;
            });
            this.length = tracks.length;
        },
    } as FakeAudioTrackList;
    list.replace(initial);
    return list;
}

function createVideo(audioTracks?: FakeAudioTrackList): HTMLVideoElement {
    const video = document.createElement('video') as HTMLVideoElement & {
        audioTracks?: FakeAudioTrackList;
    };
    if (audioTracks) {
        Object.defineProperty(video, 'audioTracks', {
            configurable: true,
            value: audioTracks,
        });
    }
    return video;
}

describe('WebVideoNativeAudioTracks', () => {
    it('is inert when the browser does not expose audioTracks', () => {
        const refresh = jest.fn();
        const tracks = new WebVideoNativeAudioTracks({
            video: createVideo(),
            refresh,
        });

        expect(() => tracks.bind()).not.toThrow();
        expect(tracks.getAudioTracks()).toEqual([]);
        expect(() => tracks.setAudioTrack(0)).not.toThrow();
    });

    it('projects labels and keeps IDs stable when WebKit reorders tracks', () => {
        const english = { label: 'English', enabled: true };
        const french = { language: 'fr', enabled: false };
        const list = createTrackList([english, french]);
        const tracks = new WebVideoNativeAudioTracks({
            video: createVideo(list),
            refresh: jest.fn(),
        });

        tracks.bind();
        expect(tracks.getAudioTracks()).toEqual([
            { id: 0, label: 'English', selected: true },
            { id: 1, label: 'fr', selected: false },
        ]);

        list.replace([french, english]);
        expect(tracks.getAudioTracks()).toEqual([
            { id: 1, label: 'fr', selected: false },
            { id: 0, label: 'English', selected: true },
        ]);
    });

    it('selects Spanish once and does not undo a later engine choice', () => {
        const english = { language: 'en', enabled: true };
        const spanish = { label: 'Español Latino', enabled: false };
        const list = createTrackList([english, spanish]);
        const tracks = new WebVideoNativeAudioTracks({
            video: createVideo(list),
            refresh: jest.fn(),
        });

        tracks.bind();
        expect([english.enabled, spanish.enabled]).toEqual([false, true]);

        english.enabled = true;
        spanish.enabled = false;
        list.emit('change');
        expect([english.enabled, spanish.enabled]).toEqual([true, false]);
    });

    it('waits for a late Spanish addtrack event', () => {
        const english = { language: 'en', enabled: true };
        const spanish = { language: 'es-MX', enabled: false };
        const list = createTrackList([english]);
        const tracks = new WebVideoNativeAudioTracks({
            video: createVideo(list),
            refresh: jest.fn(),
        });

        tracks.bind();
        expect(english.enabled).toBe(true);

        list.replace([english, spanish]);
        list.emit('addtrack');
        expect([english.enabled, spanish.enabled]).toEqual([false, true]);
    });

    it('keeps a manual selection authoritative over late Spanish tracks', () => {
        const english = { language: 'en', enabled: true };
        const spanish = { language: 'es', enabled: false };
        const list = createTrackList([english]);
        const tracks = new WebVideoNativeAudioTracks({
            video: createVideo(list),
            refresh: jest.fn(),
        });

        tracks.bind();
        tracks.setAudioTrack(tracks.getAudioTracks()[0].id);
        list.replace([english, spanish]);
        list.emit('addtrack');

        expect([english.enabled, spanish.enabled]).toEqual([true, false]);
    });

    it('binds and removes stable list and metadata listeners', () => {
        const list = createTrackList([{ enabled: true }]);
        const video = createVideo(list);
        const addVideoListener = jest.spyOn(video, 'addEventListener');
        const removeVideoListener = jest.spyOn(video, 'removeEventListener');
        const tracks = new WebVideoNativeAudioTracks({
            video,
            refresh: jest.fn(),
        });

        tracks.bind();
        const listListeners = new Map(
            list.addEventListener.mock.calls.map(([type, listener]) => [
                type,
                listener,
            ])
        );
        const metadataListener = addVideoListener.mock.calls.find(
            ([type]) => type === 'loadedmetadata'
        )?.[1];
        tracks.clear();

        expect([...listListeners.keys()]).toEqual([
            'addtrack',
            'removetrack',
            'change',
        ]);
        for (const [type, listener] of listListeners) {
            expect(list.removeEventListener).toHaveBeenCalledWith(
                type,
                listener
            );
        }
        expect(removeVideoListener).toHaveBeenCalledWith(
            'loadedmetadata',
            metadataListener
        );
        expect(tracks.getAudioTracks()).toEqual([]);
    });
});
