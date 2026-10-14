import {
    EMBEDDED_MPV_HARDWARE_DEFAULT_OPTIONS,
    EMBEDDED_MPV_LANGUAGE_DEFAULT_OPTIONS,
    EMBEDDED_MPV_NETWORK_DEFAULT_OPTIONS,
} from '@iptvnator/shared/interfaces';

const mockStoreGet = jest.fn();
const mockResolveTlsCaOption = jest.fn();

jest.mock('electron', () => ({
    app: { isPackaged: true },
}));
jest.mock('./store.service', () => ({
    EMBEDDED_MPV_AUTO_RECONNECT: 'embeddedMpvAutoReconnect',
    EMBEDDED_MPV_EXTRA_OPTIONS: 'embeddedMpvExtraOptions',
    store: { get: mockStoreGet },
}));
jest.mock('./embedded-mpv-tls-ca-option', () => ({
    resolveEmbeddedMpvTlsCaOption: mockResolveTlsCaOption,
}));

import { readEmbeddedMpvSessionOptions } from './embedded-mpv-session-options';

describe('readEmbeddedMpvSessionOptions', () => {
    beforeEach(() => {
        mockStoreGet.mockImplementation((key: string, fallback: unknown) => {
            if (key === 'embeddedMpvExtraOptions') {
                return 'tls-ca-file=C:/custom/cacert.pem';
            }
            return fallback;
        });
        mockResolveTlsCaOption.mockReturnValue(
            'tls-ca-file=C:/ZenPlay/resources/certs/cacert.pem'
        );
    });

    it('places the bundled CA before an explicit user override', () => {
        expect(readEmbeddedMpvSessionOptions()).toEqual({
            extraOptions: [
                ...EMBEDDED_MPV_HARDWARE_DEFAULT_OPTIONS,
                ...EMBEDDED_MPV_NETWORK_DEFAULT_OPTIONS,
                ...EMBEDDED_MPV_LANGUAGE_DEFAULT_OPTIONS,
                'tls-ca-file=C:/ZenPlay/resources/certs/cacert.pem',
                'tls-ca-file=C:/custom/cacert.pem',
            ],
            autoReconnect: true,
        });
        expect(mockResolveTlsCaOption).toHaveBeenCalledWith(
            expect.objectContaining({
                platform: process.platform,
                isPackaged: true,
            })
        );
    });

    it('omits the managed option when no packaged CA is available', () => {
        mockResolveTlsCaOption.mockReturnValue(null);

        expect(readEmbeddedMpvSessionOptions().extraOptions).not.toContain(
            expect.stringContaining('ZenPlay/resources/certs')
        );
    });
});
