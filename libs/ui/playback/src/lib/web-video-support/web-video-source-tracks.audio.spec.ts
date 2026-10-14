import { WebVideoSourceTracks } from './web-video-source-tracks';

interface FakeAudioTrack {
    label: string;
    language: string;
    enabled: boolean;
}

function createNativeVideo(tracks: FakeAudioTrack[]): HTMLVideoElement {
    const list = {
        length: tracks.length,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    } as {
        length: number;
        [index: number]: FakeAudioTrack;
        addEventListener: jest.Mock;
        removeEventListener: jest.Mock;
    };
    tracks.forEach((track, index) => {
        list[index] = track;
    });

    const video = document.createElement('video') as HTMLVideoElement & {
        audioTracks?: typeof list;
    };
    Object.defineProperty(video, 'audioTracks', {
        configurable: true,
        value: list,
    });
    return video;
}

describe('WebVideoSourceTracks native audio integration', () => {
    it('exposes Safari native tracks, prefers Spanish, and delegates selection', () => {
        const english = {
            label: 'English',
            language: 'en',
            enabled: true,
        };
        const spanish = {
            label: 'Español Latino',
            language: 'es-MX',
            enabled: false,
        };
        const tracks = new WebVideoSourceTracks({
            video: createNativeVideo([english, spanish]),
            showCaptions: () => false,
        });

        tracks.setSource({ kind: 'native' });
        expect(tracks.getAudioTracks()).toEqual([
            { id: 0, label: 'English', selected: false },
            { id: 1, label: 'Español Latino', selected: true },
        ]);

        tracks.setAudioTrack(0);
        expect([english.enabled, spanish.enabled]).toEqual([true, false]);

        tracks.setSource({ kind: 'mpegts' });
        expect(tracks.getAudioTracks()).toEqual([]);
        tracks.destroy();
    });
});
