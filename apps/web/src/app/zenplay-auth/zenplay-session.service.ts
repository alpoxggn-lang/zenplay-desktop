import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
    PlaylistsService,
    XtreamConnectionTestService,
} from '@iptvnator/services';
import { normalizeXtreamServerUrl } from '@iptvnator/shared/interfaces';
import { firstValueFrom } from 'rxjs';
import { getRuntimeBackendUrl } from '../services/runtime-config';
import { ZenPlayAccountExpiryAlertService } from '../services/zenplay-account-expiry-alert.service';
import { ZENPLAY_PLAYLIST_ID, ZENPLAY_SERVER_URL } from './zenplay.constants';
import { ZenPlayProfileService } from './zenplay-profile.service';

interface StoredZenPlayConnection {
    readonly password: string;
    readonly username: string;
}

interface CachedRestore {
    readonly connection: StoredZenPlayConnection;
    readonly result: Promise<boolean>;
}

/** Restores the durable browser login and refreshes its ephemeral media cookie. */
@Injectable({ providedIn: 'root' })
export class ZenPlaySessionService {
    private readonly connectionTest = inject(XtreamConnectionTestService);
    private readonly expiryAlerts = inject(ZenPlayAccountExpiryAlertService);
    private readonly http = inject(HttpClient);
    private readonly playlists = inject(PlaylistsService);
    private readonly profiles = inject(ZenPlayProfileService);
    private cachedRestore: CachedRestore | null = null;

    async restore(): Promise<boolean> {
        const connection = await this.readConnection();
        if (!connection) {
            this.cachedRestore = null;
            return false;
        }

        const cached = this.cachedRestore;
        if (
            cached?.connection.username === connection.username &&
            cached.connection.password === connection.password
        ) {
            return cached.result;
        }

        const result = this.validate(connection);
        this.cachedRestore = { connection, result };
        return result;
    }

    rememberAuthenticated(username: string, password: string): void {
        const connection = {
            username: username.trim(),
            password: password.trim(),
        };
        this.cachedRestore = {
            connection,
            result: Promise.resolve(true),
        };
    }

    async logout(): Promise<void> {
        this.cachedRestore = null;
        await this.clearStoredSession();
    }

    private async readConnection(): Promise<StoredZenPlayConnection | null> {
        try {
            const playlist = await firstValueFrom(
                this.playlists.getPlaylistById(ZENPLAY_PLAYLIST_ID)
            );
            const username = playlist?.username?.trim();
            const password = playlist?.password?.trim();
            if (
                !username ||
                !password ||
                !playlist?.serverUrl ||
                normalizeXtreamServerUrl(playlist.serverUrl) !==
                    ZENPLAY_SERVER_URL
            ) {
                return null;
            }
            return { username, password };
        } catch {
            return null;
        }
    }

    private async validate(
        connection: StoredZenPlayConnection
    ): Promise<boolean> {
        let status: 'active' | 'expired' | 'inactive' | 'unavailable';
        try {
            status = (
                await this.connectionTest.test(
                    {
                        serverUrl: ZENPLAY_SERVER_URL,
                        ...connection,
                    },
                    () => true,
                    false
                )
            ).status;
        } catch {
            status = 'unavailable';
        }

        // Keep the durable login during an outage, but do not cache that
        // outage as a successful media-session renewal for this app's lifetime.
        // Only clear our own request; an account switch may already own it.
        if (
            status === 'unavailable' &&
            this.cachedRestore?.connection === connection
        ) {
            this.cachedRestore = null;
        }

        if (status !== 'inactive' && status !== 'expired') {
            // A network or backend outage must never sign a remembered user out.
            return true;
        }

        if (status === 'expired') {
            // Preserve the day-of-expiry warning before deleting the account
            // that the alert service otherwise observes through NgRx.
            await this.expiryAlerts.notifyBeforeExpiredSessionClear(
                connection.username,
                connection.password
            );
        }

        this.cachedRestore = null;
        await this.clearStoredSession();
        return false;
    }

    private async clearStoredSession(): Promise<void> {
        this.profiles.requireSelection();
        await Promise.all([
            firstValueFrom(
                this.playlists.deletePlaylist(ZENPLAY_PLAYLIST_ID)
            ).catch(() => undefined),
            this.revokeMediaSession().catch(() => undefined),
        ]);
    }

    private async revokeMediaSession(): Promise<void> {
        await firstValueFrom(
            this.http.delete(`${getRuntimeBackendUrl()}/media/session`, {
                withCredentials: true,
            })
        );
    }
}
