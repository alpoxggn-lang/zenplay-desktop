import { ipcMain, Notification, powerMonitor } from 'electron';
import {
    APP_RESUMED,
    ZENPLAY_ACCOUNT_EXPIRY_NOTIFY,
} from '@iptvnator/shared/interfaces/ipc-commands';
import {
    formatZenPlayAccountExpiryMessage,
    isZenPlayAccountExpiryAlert,
    type ZenPlayAccountExpiryNotificationRequest,
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

const MAX_NOTIFICATION_TITLE_LENGTH = 120;
const MAX_NOTIFICATION_BODY_LENGTH = 500;
const MAX_DELIVERED_NOTIFICATION_KEYS = 16;
const MIN_NOTIFICATION_INTERVAL_MS = 5_000;

function hasUnsafeNotificationText(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) continue;
        if (
            codePoint <= 0x08 ||
            codePoint === 0x0b ||
            codePoint === 0x0c ||
            (codePoint >= 0x0e && codePoint <= 0x1f) ||
            codePoint === 0x7f ||
            (codePoint >= 0x202a && codePoint <= 0x202e) ||
            (codePoint >= 0x2066 && codePoint <= 0x2069)
        ) {
            return true;
        }
    }
    return false;
}

function readOptionalNotificationText(
    value: unknown,
    maxLength: number
): string | null | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text.length > 0 &&
        text.length <= maxLength &&
        !hasUnsafeNotificationText(text)
        ? text
        : null;
}

function isTrustedNotificationSender(
    event: Electron.IpcMainInvokeEvent,
    mainWindow: Electron.BrowserWindow | null
): boolean {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return (
        event.sender === mainWindow.webContents &&
        event.senderFrame === mainWindow.webContents.mainFrame
    );
}

function notificationDedupeKey(request: unknown): string | null {
    return isZenPlayAccountExpiryAlert(request)
        ? `${request.expiresOn}:${request.kind}`
        : null;
}

export function showZenPlayAccountExpiryNotification(
    request: unknown,
    platform: string,
    gateway: SystemNotificationGateway
): boolean {
    if (platform !== 'win32' && platform !== 'darwin') return false;

    if (!isZenPlayAccountExpiryAlert(request)) return false;
    const candidate = request as ZenPlayAccountExpiryNotificationRequest;
    const localizedTitle = readOptionalNotificationText(
        candidate.title,
        MAX_NOTIFICATION_TITLE_LENGTH
    );
    const localizedBody = readOptionalNotificationText(
        candidate.body,
        MAX_NOTIFICATION_BODY_LENGTH
    );
    if (localizedTitle === null || localizedBody === null) return false;

    const body = localizedBody ?? formatZenPlayAccountExpiryMessage(candidate);
    if (!body) return false;

    try {
        if (!gateway.isSupported()) return false;
        gateway.show({
            body,
            title: localizedTitle ?? 'ZenPlay · Aviso de vencimiento',
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
        const deliveredKeys = new Set<string>();
        let lastShownAt: number | null = null;

        ipcMain.handle(ZENPLAY_ACCOUNT_EXPIRY_NOTIFY, (event, request) => {
            const mainWindow = getMainWindow();
            if (!isTrustedNotificationSender(event, mainWindow)) return false;

            const dedupeKey = notificationDedupeKey(request);
            if (!dedupeKey) return false;
            if (deliveredKeys.has(dedupeKey)) return true;

            const now = Date.now();
            if (
                lastShownAt !== null &&
                now - lastShownAt < MIN_NOTIFICATION_INTERVAL_MS
            ) {
                return false;
            }

            const shown = showZenPlayAccountExpiryNotification(
                request,
                platform,
                gateway
            );
            if (!shown) return false;

            lastShownAt = now;
            deliveredKeys.add(dedupeKey);
            while (deliveredKeys.size > MAX_DELIVERED_NOTIFICATION_KEYS) {
                const oldest = deliveredKeys.values().next().value;
                if (typeof oldest !== 'string') break;
                deliveredKeys.delete(oldest);
            }
            return true;
        });

        powerMonitor.on('resume', () => {
            const mainWindow = getMainWindow();
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.webContents.send(APP_RESUMED);
        });

        return ipcMain;
    }
}
