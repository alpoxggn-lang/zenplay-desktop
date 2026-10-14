import {
    EMBEDDED_MPV_HARDWARE_DEFAULT_OPTIONS,
    EMBEDDED_MPV_LANGUAGE_DEFAULT_OPTIONS,
    EMBEDDED_MPV_NETWORK_DEFAULT_OPTIONS,
    normalizeEmbeddedMpvExtraOptions,
    parseEmbeddedMpvExtraOptions,
    resolveEmbeddedMpvSessionOptionArguments,
    validateEmbeddedMpvExtraOptions,
} from './embedded-mpv-extra-options.util';

describe('embedded MPV extra options', () => {
    it('parses one key=value pair per line and tolerates CRLF, spaces and a -- prefix', () => {
        expect(
            parseEmbeddedMpvExtraOptions(
                'hwdec = auto-safe\r\n\n  --cache-secs=30  \ndemuxer-lavf-o=reconnect=1,reconnect_delay_max=5'
            )
        ).toEqual([
            { key: 'hwdec', value: 'auto-safe' },
            { key: 'cache-secs', value: '30' },
            {
                key: 'demuxer-lavf-o',
                value: 'reconnect=1,reconnect_delay_max=5',
            },
        ]);
    });

    it('skips lines without a value or with a malformed key', () => {
        expect(
            parseEmbeddedMpvExtraOptions(
                'hwdec=\nno-border\n=auto\n bad key=1\nvolume=50'
            )
        ).toEqual([{ key: 'volume', value: '50' }]);
    });

    it('normalizes to canonical lines but keeps malformed lines for the user to fix', () => {
        expect(
            normalizeEmbeddedMpvExtraOptions(
                ' --hwdec = auto \n\nnot an option\n'
            )
        ).toBe('hwdec=auto\nnot an option');
        expect(normalizeEmbeddedMpvExtraOptions(undefined)).toBe('');
        expect(normalizeEmbeddedMpvExtraOptions(['a=1', '', 'b=2'])).toBe(
            'a=1\nb=2'
        );
    });

    it('reports malformed lines and forbidden keys separately', () => {
        expect(validateEmbeddedMpvExtraOptions('')).toBeNull();
        expect(validateEmbeddedMpvExtraOptions(undefined)).toBeNull();
        expect(validateEmbeddedMpvExtraOptions('hwdec=auto')).toBeNull();
        expect(
            validateEmbeddedMpvExtraOptions(
                'hwdec=auto\noops\nvo=null\nwid=1\nvo=gpu'
            )
        ).toEqual({ invalidLines: ['oops'], forbiddenKeys: ['vo', 'wid'] });
        expect(
            validateEmbeddedMpvExtraOptions('input-ipc-server=/tmp/s')
        ).toEqual({
            forbiddenKeys: ['input-ipc-server'],
        });
    });

    it('prepends the network defaults and drops forbidden keys for the addon', () => {
        expect(resolveEmbeddedMpvSessionOptionArguments('')).toEqual([
            ...EMBEDDED_MPV_HARDWARE_DEFAULT_OPTIONS,
            ...EMBEDDED_MPV_NETWORK_DEFAULT_OPTIONS,
            ...EMBEDDED_MPV_LANGUAGE_DEFAULT_OPTIONS,
        ]);
        expect(
            resolveEmbeddedMpvSessionOptionArguments(
                'wid=42\nhwdec=no\nnetwork-timeout=3\nbroken line'
            )
        ).toEqual([
            ...EMBEDDED_MPV_HARDWARE_DEFAULT_OPTIONS,
            ...EMBEDDED_MPV_NETWORK_DEFAULT_OPTIONS,
            ...EMBEDDED_MPV_LANGUAGE_DEFAULT_OPTIONS,
            'hwdec=no',
            'network-timeout=3',
        ]);
    });

    it('keeps the user override after the default it replaces', () => {
        const options =
            resolveEmbeddedMpvSessionOptionArguments('network-timeout=3');
        expect(options.indexOf('network-timeout=8')).toBeLessThan(
            options.indexOf('network-timeout=3')
        );
    });

    it('uses a bounded network cache without delaying initial playback', () => {
        expect(EMBEDDED_MPV_NETWORK_DEFAULT_OPTIONS).toEqual(
            expect.arrayContaining([
                'network-timeout=8',
                'cache=yes',
                'cache-pause-initial=no',
                'cache-secs=15',
                'demuxer-max-bytes=67108864',
                'demuxer-max-back-bytes=33554432',
                'demuxer-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=2',
            ])
        );
    });

    it('prefers safe hardware decoding while preserving a software override', () => {
        const options = resolveEmbeddedMpvSessionOptionArguments('hwdec=no');
        expect(options[0]).toBe('hwdec=auto-safe');
        expect(options.indexOf('hwdec=auto-safe')).toBeLessThan(
            options.indexOf('hwdec=no')
        );
    });

    it('prefers Spanish audio while preserving a later user language override', () => {
        const options =
            resolveEmbeddedMpvSessionOptionArguments('alang=en,eng');
        expect(options).toContain('alang=es-419,es-MX,es-ES,es,spa,esp');
        expect(
            options.indexOf('alang=es-419,es-MX,es-ES,es,spa,esp')
        ).toBeLessThan(options.indexOf('alang=en,eng'));
    });

    it('places managed session defaults before user overrides', () => {
        expect(
            resolveEmbeddedMpvSessionOptionArguments(
                'tls-ca-file=C:/custom/cacert.pem',
                ['tls-ca-file=C:/ZenPlay/certs/cacert.pem']
            )
        ).toEqual([
            ...EMBEDDED_MPV_HARDWARE_DEFAULT_OPTIONS,
            ...EMBEDDED_MPV_NETWORK_DEFAULT_OPTIONS,
            ...EMBEDDED_MPV_LANGUAGE_DEFAULT_OPTIONS,
            'tls-ca-file=C:/ZenPlay/certs/cacert.pem',
            'tls-ca-file=C:/custom/cacert.pem',
        ]);
    });
});
