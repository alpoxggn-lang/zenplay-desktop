import { ipcMain, Notification, powerMonitor } from 'electron';
import {
    APP_RESUMED,
    ZENPLAY_ACCOUNT_EXPIRY_NOTIFY,
} from '@iptvnator/shared/interfaces/ipc-commands';
import {
    formatZenPlayAccountExpiryMessage,
    type ZenPlayAccountExpiryAlert,
} from '@iptvnator/shared/interfaces';

export interface SystemNotificationGateway {
    isSupported(): boolean;
    show(options: Electron.NotificationConstructorOptions): void;
}

export interface ZenPlayAccountExpiryEventsOptions {
    readonly notificationGateway?: SystemNotificationGateway;
    readonly platform?: string;
}

const electronNotificationGateway: SystemNotificationGateway = {
    isSupported: () => Notification.isSupported(),
    show: (options) => new Notification(options).show(),
};

export function showZenPlayAccountExpiryNotification(
    request: unknown,
    platform: string,
    gateway: SystemNotificationGateway
): boolean {
    if (platform !== 'win32' && platform !== 'darwin') return false;

    const message = formatZenPlayAccountExpiryMessage(
        request as ZenPlayAccountExpiryAlert
    );
    if (!message) return false;

    try {
        if (!gateway.isSupported()) return false;
        gateway.show({
            body: message,
            title: 'ZenPlay · Aviso de vencimiento',
        });
        return true;
    } catch {
        return false;
    }
}

/** Owns the narrow system-notification IPC and OS resume push. */
export default class ZenPlayAccountExpiryEvents {
    static bootstrap(
        getMainWindow: () => Electron.BrowserWindow | null,
        options: ZenPlayAccountExpiryEventsOptions = {}
    ): Electron.IpcMain {
        const gateway =
            options.notificationGateway ?? electronNotificationGateway;
        const platform = options.platform ?? process.platform;

        ipcMain.handle(ZENPLAY_ACCOUNT_EXPIRY_NOTIFY, (_event, request) =>
            showZenPlayAccountExpiryNotification(request, platform, gateway)
        );

        powerMonitor.on('resume', () => {
            const mainWindow = getMainWindow();
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.webContents.send(APP_RESUMED);
        });

        return ipcMain;
    }
}
