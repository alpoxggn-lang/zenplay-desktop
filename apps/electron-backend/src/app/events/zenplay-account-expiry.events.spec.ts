const handlers = new Map<
    string,
    (event: unknown, payload?: unknown) => unknown
>();
let resumeListener: (() => void) | undefined;

jest.mock('electron', () => ({
    ipcMain: {
        handle: jest.fn(
            (
                channel: string,
                handler: (event: unknown, payload?: unknown) => unknown
            ) => handlers.set(channel, handler)
        ),
    },
    Notification: class {
        static isSupported = jest.fn(() => false);
    },
    powerMonitor: {
        on: jest.fn((event: string, listener: () => void) => {
            if (event === 'resume') resumeListener = listener;
        }),
    },
}));

import {
    APP_RESUMED,
    ZENPLAY_ACCOUNT_EXPIRY_NOTIFY,
} from '@iptvnator/shared/interfaces/ipc-commands';
import ZenPlayAccountExpiryEvents, {
    showZenPlayAccountExpiryNotification,
    type SystemNotificationGateway,
} from './zenplay-account-expiry.events';

describe('ZenPlayAccountExpiryEvents', () => {
    const notificationGateway: SystemNotificationGateway = {
        isSupported: jest.fn(() => true),
        show: jest.fn(),
    };
    const webContents = { send: jest.fn() };
    const mainWindow = {
        isDestroyed: jest.fn(() => false),
        webContents,
    } as unknown as Electron.BrowserWindow;

    beforeAll(() => {
        ZenPlayAccountExpiryEvents.bootstrap(() => mainWindow, {
            notificationGateway,
            platform: 'win32',
        });
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('shows only fixed, credential-free Spanish copy on Windows and macOS', () => {
        const request = {
            kind: 'tomorrow',
            expiresOn: '2026-10-15',
            password: 'secreto',
            serverUrl: 'https://portal.example.test',
            username: 'cliente',
        };

        expect(
            showZenPlayAccountExpiryNotification(
                request,
                'darwin',
                notificationGateway
            )
        ).toBe(true);

        const options = (notificationGateway.show as jest.Mock).mock
            .calls[0][0] as Electron.NotificationConstructorOptions;
        expect(options.title).toBe('ZenPlay · Aviso de vencimiento');
        expect(options.body).toContain('vence mañana');
        expect(JSON.stringify(options)).not.toContain('secreto');
        expect(JSON.stringify(options)).not.toContain('portal.example.test');
        expect(JSON.stringify(options)).not.toContain('cliente');
    });

    it('rejects unsupported platforms, invalid dates, and unsupported systems', () => {
        const request = { kind: 'today', expiresOn: '2026-10-14' };

        expect(
            showZenPlayAccountExpiryNotification(
                request,
                'linux',
                notificationGateway
            )
        ).toBe(false);
        expect(
            showZenPlayAccountExpiryNotification(
                { ...request, expiresOn: '2026-02-30' },
                'win32',
                notificationGateway
            )
        ).toBe(false);

        (notificationGateway.isSupported as jest.Mock).mockReturnValueOnce(
            false
        );
        expect(
            showZenPlayAccountExpiryNotification(
                request,
                'win32',
                notificationGateway
            )
        ).toBe(false);
    });

    it('registers the IPC handler and forwards OS resume to the live renderer', () => {
        const handler = handlers.get(ZENPLAY_ACCOUNT_EXPIRY_NOTIFY);
        expect(handler).toBeDefined();
        expect(handler?.({}, { kind: 'today', expiresOn: '2026-10-14' })).toBe(
            true
        );

        resumeListener?.();
        expect(webContents.send).toHaveBeenCalledWith(APP_RESUMED);
    });

    it('does not push resume events to a destroyed window', () => {
        (mainWindow.isDestroyed as jest.Mock).mockReturnValueOnce(true);

        resumeListener?.();

        expect(webContents.send).not.toHaveBeenCalled();
    });
});
