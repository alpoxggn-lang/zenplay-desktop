import { signal, WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
    DatabaseService,
    RuntimeCapabilitiesService,
    SettingsStore,
} from '@iptvnator/services';
import {
    StreamFormat,
    XtreamSerieEpisode,
    XtreamVodDetails,
} from '@iptvnator/shared/interfaces';
import { XtreamCredentials } from './xtream-api.service';
import {
    prefersTsFirstForWebLive,
    XtreamUrlService,
} from './xtream-url.service';

describe('XtreamUrlService', () => {
    let service: XtreamUrlService;
    let databaseService: {
        getAppState: jest.Mock<Promise<string | null>, [string]>;
        setAppState: jest.Mock<Promise<void>, [string, string]>;
    };
    let streamFormat: WritableSignal<StreamFormat>;
    const runtime = { isPwa: false };

    const credentials: XtreamCredentials = {
        serverUrl: 'http://demo.example',
        username: 'demo',
        password: 'secret',
    };
    const originalElectron = window.electron;
    const originalRuntimeConfig = window.__IPTVNATOR_CONFIG__;

    beforeEach(() => {
        streamFormat = signal(StreamFormat.TsStreamFormat);
        runtime.isPwa = false;
        databaseService = {
            getAppState: jest.fn().mockResolvedValue(null),
            setAppState: jest.fn().mockResolvedValue(undefined),
        };

        TestBed.configureTestingModule({
            providers: [
                XtreamUrlService,
                { provide: DatabaseService, useValue: databaseService },
                { provide: RuntimeCapabilitiesService, useValue: runtime },
                {
                    provide: SettingsStore,
                    useValue: {
                        streamFormat,
                    },
                },
            ],
        });

        service = TestBed.inject(XtreamUrlService);
    });

    afterEach(() => {
        window.electron = originalElectron;
        window.__IPTVNATOR_CONFIG__ = originalRuntimeConfig;
        jest.restoreAllMocks();
    });

    it('normalizes portal base URLs and trims credentials for live streams', () => {
        const url = service.constructLiveUrl(
            {
                serverUrl: ' https://demo.example/base/ ',
                username: ' demo ',
                password: ' secret ',
            },
            101
        );

        expect(url).toBe('https://demo.example/base/live/demo/secret/101.ts');
    });

    it('uses the first allowed provider output format when the selected live format is not allowed', () => {
        const url = service.constructLiveUrl(
            {
                ...credentials,
                allowedOutputFormats: ['m3u8'],
            },
            101
        );

        expect(url).toBe('http://demo.example/live/demo/secret/101.m3u8');
    });

    it('auto-selects HLS for live streams when the provider allows it', () => {
        streamFormat.set(StreamFormat.AutoStreamFormat);

        const url = service.constructLiveUrl(
            {
                ...credentials,
                allowedOutputFormats: ['ts', 'm3u8'],
            },
            101
        );

        expect(url).toBe('http://demo.example/live/demo/secret/101.m3u8');
    });

    it('auto-selects MPEG-TS for live streams when it is the only provider format', () => {
        streamFormat.set(StreamFormat.AutoStreamFormat);

        const url = service.constructLiveUrl(
            {
                ...credentials,
                allowedOutputFormats: ['ts'],
            },
            101
        );

        expect(url).toBe('http://demo.example/live/demo/secret/101.ts');
    });

    it('uses HLS as the auto live-stream fallback when provider formats are unknown', () => {
        streamFormat.set(StreamFormat.AutoStreamFormat);

        const url = service.constructLiveUrl(credentials, 101);

        expect(url).toBe('http://demo.example/live/demo/secret/101.m3u8');
    });

    it('keeps the manual live-stream format override when provider formats are unknown', () => {
        streamFormat.set(StreamFormat.TsStreamFormat);

        const url = service.constructLiveUrl(credentials, 101);

        expect(url).toBe('http://demo.example/live/demo/secret/101.ts');
    });

    it('uses credential-free proxy URLs and TS-first Auto on Chromium PWA', () => {
        runtime.isPwa = true;
        window.__IPTVNATOR_CONFIG__ = {
            BACKEND_URL: ' https://zenplay.test/api/ ',
        };
        jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
            'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36'
        );
        streamFormat.set(StreamFormat.AutoStreamFormat);
        const pwaCredentials = {
            ...credentials,
            allowedOutputFormats: ['m3u8', 'ts'],
        };

        const primary = service.constructLiveUrl(pwaCredentials, 101);
        const fallback = service.constructAutoLiveFallbackUrl(
            pwaCredentials,
            101
        );

        expect(primary).toBe('https://zenplay.test/api/media/live/101.ts');
        expect(fallback).toBe(
            'https://zenplay.test/api/media/live/101.m3u8'
        );
        expect(`${primary}${fallback}`).not.toContain('demo');
        expect(`${primary}${fallback}`).not.toContain('secret');
    });

    it('uses HLS-first Auto on Safari PWA and TS as its one fallback', () => {
        runtime.isPwa = true;
        jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
        );
        streamFormat.set(StreamFormat.AutoStreamFormat);
        const pwaCredentials = {
            ...credentials,
            allowedOutputFormats: ['ts', 'm3u8'],
        };

        expect(service.constructLiveUrl(pwaCredentials, 101)).toBe(
            '/api/media/live/101.m3u8'
        );
        expect(
            service.constructAutoLiveFallbackUrl(pwaCredentials, 101)
        ).toBe('/api/media/live/101.ts');
    });

    it('respects the only provider format in PWA Auto mode', () => {
        runtime.isPwa = true;
        jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
            'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36'
        );
        streamFormat.set(StreamFormat.AutoStreamFormat);

        expect(
            service.constructLiveUrl(
                { ...credentials, allowedOutputFormats: ['m3u8'] },
                101
            )
        ).toBe('/api/media/live/101.m3u8');
        expect(
            service.constructAutoLiveFallbackUrl(
                { ...credentials, allowedOutputFormats: ['m3u8'] },
                101
            )
        ).toBeUndefined();
    });

    it('uses credential-free proxy routes for PWA movies and episodes', () => {
        runtime.isPwa = true;
        const vodItem = {
            info: [],
            stream_id: 101,
            container_extension: 'MP4',
        } as XtreamVodDetails & {
            stream_id: number;
            container_extension: string;
        };
        const episode: XtreamSerieEpisode = {
            added: '',
            container_extension: 'MKV',
            custom_sid: '',
            direct_source: '',
            episode_num: 1,
            id: '202',
            info: [],
            season: 1,
            title: 'Episode',
        };

        expect(service.constructVodUrl(credentials, vodItem)).toBe(
            '/api/media/movie/101.mp4'
        );
        expect(service.constructEpisodeUrl(credentials, episode)).toBe(
            '/api/media/series/202.mkv'
        );
    });

    it('fails closed for PWA catch-up instead of exposing direct credentials', async () => {
        runtime.isPwa = true;

        expect(
            service.constructCatchupUrl(
                credentials,
                101,
                1_700_000_000,
                1_700_003_600,
                'rest:ts'
            )
        ).toBe('');
        await expect(
            service.resolveCatchupUrl(
                'playlist-1',
                credentials,
                101,
                1_700_000_000,
                1_700_003_600
            )
        ).resolves.toBe('');
        expect(databaseService.getAppState).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'desktop Safari',
            browser: {
                userAgent:
                    'Mozilla/5.0 Version/18.0 Safari/605.1.15',
                platform: 'MacIntel',
                maxTouchPoints: 0,
            },
            expected: false,
        },
        {
            name: 'iPadOS desktop identity',
            browser: {
                userAgent:
                    'Mozilla/5.0 Macintosh AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
                platform: 'MacIntel',
                maxTouchPoints: 5,
            },
            expected: false,
        },
        {
            name: 'Edge',
            browser: { userAgent: 'Mozilla/5.0 Chrome/130 Edg/130' },
            expected: true,
        },
        {
            name: 'Firefox',
            browser: { userAgent: 'Mozilla/5.0 Firefox/131.0' },
            expected: true,
        },
    ])(
        'selects the safe web Auto preference for $name',
        ({ browser, expected }) => {
            expect(prefersTsFirstForWebLive(browser)).toBe(expected);
        }
    );

    it('builds an Auto TS alternative with encoded credentials and the provider subpath', () => {
        streamFormat.set(StreamFormat.AutoStreamFormat);
        expect(
            service.constructAutoLiveTsUrl(
                {
                    serverUrl:
                        'https://demo.example/panel/player_api.php?token=unused',
                    username: 'a/b',
                    password: 'x?y#z',
                    allowedOutputFormats: [' M3U8 ', ' TS '],
                },
                101
            )
        ).toBe('https://demo.example/panel/live/a%2Fb/x%3Fy%23z/101.ts');
    });

    it.each([undefined, [], ['m3u8'], ['rtmp'], ['ts']])(
        'does not guess an HLS-to-TS alternative for %j',
        (allowedOutputFormats) => {
            streamFormat.set(StreamFormat.AutoStreamFormat);
            expect(
                service.constructAutoLiveTsUrl(
                    { ...credentials, allowedOutputFormats },
                    101
                )
            ).toBeUndefined();
        }
    );

    it.each([StreamFormat.TsStreamFormat, StreamFormat.M3u8StreamFormat])(
        'respects manual %s even with both formats advertised',
        (format) => {
            streamFormat.set(format);
            expect(
                service.constructAutoLiveTsUrl(
                    { ...credentials, allowedOutputFormats: ['m3u8', 'ts'] },
                    101
                )
            ).toBeUndefined();
        }
    );

    it('constructs a VOD URL from catalog fields when metadata is empty', () => {
        const vodItem = {
            info: [],
            stream_id: 101,
            container_extension: 'mp4',
        } as XtreamVodDetails & {
            stream_id: number;
            container_extension: string;
        };

        expect(service.constructVodUrl(credentials, vodItem)).toBe(
            'http://demo.example/movie/demo/secret/101.mp4'
        );
    });

    it('keeps the direct provider series URL in Electron', () => {
        const episode: XtreamSerieEpisode = {
            added: '',
            container_extension: 'mkv',
            custom_sid: '',
            direct_source: '',
            episode_num: 1,
            id: '202',
            info: [],
            season: 1,
            title: 'Episode',
        };

        expect(service.constructEpisodeUrl(credentials, episode)).toBe(
            'http://demo.example/series/demo/secret/202.mkv'
        );
    });

    it('returns empty stream URLs instead of throwing for invalid stored server URLs', () => {
        const invalidCredentials: XtreamCredentials = {
            ...credentials,
            serverUrl: 'https://demo:secret@demo.example',
        };
        const vodItem: XtreamVodDetails = {
            movie_data: {
                added: '',
                category_id: '',
                container_extension: 'mp4',
                custom_sid: null,
                direct_source: '',
                name: 'Movie',
                stream_id: 101,
            },
        };
        const episode: XtreamSerieEpisode = {
            added: '',
            container_extension: 'mp4',
            custom_sid: '',
            direct_source: '',
            episode_num: 1,
            id: '202',
            info: [],
            season: 1,
            title: 'Episode',
        };

        expect(service.constructLiveUrl(invalidCredentials, 101)).toBe('');
        expect(service.constructVodUrl(invalidCredentials, vodItem)).toBe('');
        expect(service.constructEpisodeUrl(invalidCredentials, episode)).toBe(
            ''
        );
    });

    it('detects the legacy catchup scheme once and then uses the cached result', async () => {
        const tsOnlyCredentials: XtreamCredentials = {
            ...credentials,
            allowedOutputFormats: ['ts'],
        };
        const xtreamProbeUrl = jest
            .fn()
            .mockResolvedValueOnce({ status: 404 })
            .mockResolvedValueOnce({ status: 206 });
        window.electron = {
            xtreamProbeUrl,
        } as unknown as typeof window.electron;

        const firstUrl = await service.resolveCatchupUrl(
            'playlist-1',
            tsOnlyCredentials,
            101,
            1775296800,
            1775300400
        );
        const secondUrl = await service.resolveCatchupUrl(
            'playlist-1',
            tsOnlyCredentials,
            101,
            1775296800,
            1775300400
        );

        expect(firstUrl).toContain('/streaming/timeshift.php?');
        expect(firstUrl).toContain('extension=ts');
        expect(secondUrl).toBe(firstUrl);
        expect(xtreamProbeUrl).toHaveBeenCalledTimes(2);
        expect(databaseService.setAppState).toHaveBeenCalledWith(
            'xtream-catchup-variant:v4:playlist-1:formats:ts',
            'legacy:ts'
        );
    });

    it('redetects catchup variants when provider output formats become known', async () => {
        const xtreamProbeUrl = jest.fn(async (url: string) => ({
            status:
                url.includes('/streaming/timeshift.php?') &&
                url.includes('extension=ts')
                    ? 206
                    : url.includes('/streaming/timeshift.php?') &&
                        url.includes('extension=m3u8')
                      ? 200
                      : 0,
        }));
        window.electron = {
            xtreamProbeUrl,
        } as unknown as typeof window.electron;

        const initialUrl = await service.resolveCatchupUrl(
            'playlist-format-refresh',
            credentials,
            101,
            1775296800,
            1775300400
        );
        const refreshedUrl = await service.resolveCatchupUrl(
            'playlist-format-refresh',
            {
                ...credentials,
                allowedOutputFormats: ['m3u8'],
            },
            101,
            1775296800,
            1775300400
        );

        expect(initialUrl).toContain('extension=ts');
        expect(refreshedUrl).toContain('extension=m3u8');
        expect(xtreamProbeUrl).toHaveBeenCalledTimes(4);
        expect(databaseService.setAppState).toHaveBeenCalledWith(
            'xtream-catchup-variant:v4:playlist-format-refresh:formats:unknown',
            'legacy:ts'
        );
        expect(databaseService.setAppState).toHaveBeenCalledWith(
            'xtream-catchup-variant:v4:playlist-format-refresh:formats:m3u8',
            'legacy:m3u8'
        );
    });

    it('prefers playable legacy MPEG-TS catchup before HLS for video.js compatible playlists', async () => {
        const xtreamProbeUrl = jest.fn(async (url: string) => ({
            status:
                url.includes('/streaming/timeshift.php?') &&
                url.includes('extension=ts')
                    ? 206
                    : 0,
        }));
        window.electron = {
            xtreamProbeUrl,
        } as unknown as typeof window.electron;

        const catchupUrl = await service.resolveCatchupUrl(
            'playlist-hls',
            {
                ...credentials,
                allowedOutputFormats: ['m3u8', 'ts'],
            },
            45,
            1782532800,
            1782534600,
            'UTC'
        );

        expect(catchupUrl).toContain('/streaming/timeshift.php?');
        expect(catchupUrl).toContain('stream=45');
        expect(catchupUrl).toContain('start=2026-06-27%3A04-00');
        expect(catchupUrl).toContain('duration=30');
        expect(catchupUrl).toContain('extension=ts');
        expect(xtreamProbeUrl).toHaveBeenCalledWith(
            expect.stringContaining('/timeshift/'),
            'GET'
        );
        expect(databaseService.setAppState).toHaveBeenCalledWith(
            'xtream-catchup-variant:v4:playlist-hls:formats:m3u8,ts',
            'legacy:ts'
        );
    });

    it('falls back to legacy HLS catchup when MPEG-TS probes fail', async () => {
        const xtreamProbeUrl = jest.fn(async (url: string) => ({
            status:
                url.includes('/streaming/timeshift.php?') &&
                url.includes('extension=m3u8')
                    ? 200
                    : 0,
        }));
        window.electron = {
            xtreamProbeUrl,
        } as unknown as typeof window.electron;

        const catchupUrl = await service.resolveCatchupUrl(
            'playlist-hls-only',
            {
                ...credentials,
                allowedOutputFormats: ['m3u8', 'ts'],
            },
            45,
            1782532800,
            1782534600,
            'UTC'
        );

        expect(catchupUrl).toContain('/streaming/timeshift.php?');
        expect(catchupUrl).toContain('extension=m3u8');
        expect(databaseService.setAppState).toHaveBeenCalledWith(
            'xtream-catchup-variant:v4:playlist-hls-only:formats:m3u8,ts',
            'legacy:m3u8'
        );
    });

    describe('formatCatchupStartTime (via constructCatchupUrl)', () => {
        // 2025-03-01 02:00:00 UTC = 2025-02-28 21:00:00 America/New_York
        const timestamp = 1740794400;

        it('formats time in the server timezone when provided', () => {
            const url = service.constructCatchupUrl(
                credentials,
                101,
                timestamp,
                timestamp + 3600,
                'rest',
                'America/New_York'
            );
            expect(url).toContain('2025-02-28:21-00');
        });

        it('falls back to client local time when no timezone is given', () => {
            const url = service.constructCatchupUrl(
                credentials,
                101,
                timestamp,
                timestamp + 3600,
                'rest'
            );
            const date = new Date(timestamp * 1000);
            const pad = (n: number) => String(n).padStart(2, '0');
            const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}:${pad(date.getHours())}-${pad(date.getMinutes())}`;
            expect(url).toContain(expected);
        });

        it('falls back to client local time when an invalid timezone string is given', () => {
            const url = service.constructCatchupUrl(
                credentials,
                101,
                timestamp,
                timestamp + 3600,
                'rest',
                'UTC+5'
            );
            const date = new Date(timestamp * 1000);
            const pad = (n: number) => String(n).padStart(2, '0');
            const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}:${pad(date.getHours())}-${pad(date.getMinutes())}`;
            expect(url).toContain(expected);
        });

        it('formats in the clock-derived fixed offset persisted for a panel with an unusable timezone name', () => {
            // 02:00 UTC at UTC+03:00 is 05:00 the same day; at UTC-03:30 it
            // is 22:30 the previous day.
            expect(
                service.constructCatchupUrl(
                    credentials,
                    101,
                    timestamp,
                    timestamp + 3600,
                    'rest',
                    'UTC+03:00'
                )
            ).toContain('/60/2025-03-01:05-00/101.ts');
            expect(
                service.constructCatchupUrl(
                    credentials,
                    101,
                    timestamp,
                    timestamp + 3600,
                    'legacy',
                    'UTC-03:30'
                )
            ).toContain('start=2025-02-28%3A22-30');
        });

        it('renders server midnight as 00, never 24', () => {
            // 2025-03-01 05:00:00 UTC = 2025-03-01 00:00 America/New_York
            const midnightInNewYork = 1740805200;
            const url = service.constructCatchupUrl(
                credentials,
                101,
                midnightInNewYork,
                midnightInNewYork + 1800,
                'rest',
                'America/New_York'
            );
            expect(url).toContain('/30/2025-03-01:00-00/101.ts');
        });
    });
});
