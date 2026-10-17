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
    const mainFrame = {};
    const webContents = { mainFrame, send: jest.fn() };
    const mainWindow = {
        isDestroyed: jest.fn(() => false),
        webContents,
    } as unknown as Electron.BrowserWindow;
    const trustedEvent = {
        sender: webContents,
        senderFrame: mainFrame,
    };

    beforeEach(() => {
        handlers.clear();
        resumeListener = undefined;
        jest.clearAllMocks();
        ZenPlayAccountExpiryEvents.bootstrap(() => mainWindow, {
            notificationGateway,
            platform: 'win32',
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('shows validated localized, credential-free copy on Windows and macOS', () => {
        const request = {
            body: 'Your ZenPlay account expires tomorrow (October 15, 2026).',
            kind: 'tomorrow',
            expiresOn: '2026-10-15',
            password: 'secreto',
            serverUrl: 'https://portal.example.test',
            username: 'cliente',
            title: 'ZenPlay · Expiry notice',
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
        expect(options.title).toBe('ZenPlay · Expiry notice');
        expect(options.body).toContain('expires tomorrow');
        expect(JSON.stringify(options)).not.toContain('secreto');
        expect(JSON.stringify(options)).not.toContain('portal.example.test');
        expect(JSON.stringify(options)).not.toContain('cliente');
    });

    it('keeps old requests compatible and rejects invalid localized copy', () => {
        const request = { kind: 'today', expiresOn: '2026-10-14' };

        expect(
            showZenPlayAccountExpiryNotification(
                request,
                'win32',
                notificationGateway
            )
        ).toBe(true);
        expect(notificationGateway.show).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.stringContaining('vence hoy'),
                title: 'ZenPlay · Aviso de vencimiento',
            })
        );

        expect(
            showZenPlayAccountExpiryNotification(
                { ...request, body: 'x'.repeat(501) },
                'win32',
                notificationGateway
            )
        ).toBe(false);
        expect(
            showZenPlayAccountExpiryNotification(
                { ...request, title: '   ' },
                'win32',
                notificationGateway
            )
        ).toBe(false);
        expect(
            showZenPlayAccountExpiryNotification(
                { ...request, title: 'ZenPlay\u202e fake' },
                'win32',
                notificationGateway
            )
        ).toBe(false);
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
        const request = { kind: 'today', expiresOn: '2026-10-14' };
        expect(handler?.(trustedEvent, request)).toBe(true);
        expect(handler?.(trustedEvent, request)).toBe(true);
        expect(notificationGateway.show).toHaveBeenCalledTimes(1);

        resumeListener?.();
        expect(webContents.send).toHaveBeenCalledWith(APP_RESUMED);
    });

    it('rejects notification IPC from another webContents or a child frame', () => {
        const handler = handlers.get(ZENPLAY_ACCOUNT_EXPIRY_NOTIFY);
        const request = { kind: 'today', expiresOn: '2026-10-14' };

        expect(
            handler?.({ sender: { id: 99 }, senderFrame: mainFrame }, request)
        ).toBe(false);
        expect(
            handler?.({ sender: webContents, senderFrame: {} }, request)
        ).toBe(false);
        expect(notificationGateway.show).not.toHaveBeenCalled();
    });

    it('rate-limits different valid expiry notifications in the main process', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-10-14T12:00:00Z'));
        const handler = handlers.get(ZENPLAY_ACCOUNT_EXPIRY_NOTIFY);

        expect(
            handler?.(trustedEvent, {
                kind: 'today',
                expiresOn: '2026-10-14',
            })
        ).toBe(true);
        expect(
            handler?.(trustedEvent, {
                kind: 'tomorrow',
                expiresOn: '2026-10-15',
            })
        ).toBe(false);

        jest.advanceTimersByTime(5_000);
        expect(
            handler?.(trustedEvent, {
                kind: 'tomorrow',
                expiresOn: '2026-10-15',
            })
        ).toBe(true);
        expect(notificationGateway.show).toHaveBeenCalledTimes(2);
    });

    it('does not push resume events to a destroyed window', () => {
        (mainWindow.isDestroyed as jest.Mock).mockReturnValueOnce(true);

        resumeListener?.();

        expect(webContents.send).not.toHaveBeenCalled();
    });
});
