import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { PlaylistActions } from '@iptvnator/m3u-state';
import { XtreamApiService } from '@iptvnator/portal/xtream/data-access';
import {
    PlaylistsService,
    XtreamConnectionTestService,
} from '@iptvnator/services';
import { Playlist } from '@iptvnator/shared/interfaces';
import { firstValueFrom } from 'rxjs';
import {
    ZENPLAY_PLAYLIST_ID,
    ZENPLAY_PLAYLIST_TITLE,
    ZENPLAY_SERVER_URL,
} from './zenplay.constants';
import { ZenPlayProfileService } from './zenplay-profile.service';
import { ZenPlaySessionService } from './zenplay-session.service';

export type ZenPlayLoginFailure =
    | 'credentials-required'
    | 'inactive'
    | 'expired'
    | 'unavailable'
    | 'content-unavailable'
    | 'no-content'
    | 'storage-error';

export type ZenPlayLoginResult =
    { ok: true } | { ok: false; reason: ZenPlayLoginFailure };

@Injectable({ providedIn: 'root' })
export class ZenPlayLoginService {
    private readonly connectionTest = inject(XtreamConnectionTestService);
    private readonly xtreamApi = inject(XtreamApiService);
    private readonly playlists = inject(PlaylistsService);
    private readonly profiles = inject(ZenPlayProfileService);
    private readonly session = inject(ZenPlaySessionService);
    private readonly store = inject(Store);

    async login(
        usernameValue: string,
        passwordValue: string
    ): Promise<ZenPlayLoginResult> {
        const username = usernameValue.trim();
        const password = passwordValue.trim();
        if (!username || !password) {
            return { ok: false, reason: 'credentials-required' };
        }

        const credentials = {
            serverUrl: ZENPLAY_SERVER_URL,
            username,
            password,
        };

        try {
            const connection = await this.connectionTest.test(
                credentials,
                () => true,
                false
            );
            if (connection.status !== 'active') {
                return { ok: false, reason: connection.status };
            }

            const categories = await Promise.all(
                (['live', 'vod', 'series'] as const).map(async (type) => {
                    try {
                        return {
                            available: true,
                            items: await this.xtreamApi.getCategories(
                                credentials,
                                type,
                                { suppressErrorLog: true }
                            ),
                        };
                    } catch {
                        return { available: false, items: [] };
                    }
                })
            );
            const successful = categories.filter((result) => result.available);
            if (successful.length === 0) {
                return { ok: false, reason: 'content-unavailable' };
            }
            if (!successful.some((result) => result.items.length > 0)) {
                return { ok: false, reason: 'no-content' };
            }

            await this.persistConnection(username, password);
            this.profiles.requireSelection();
            this.session.rememberAuthenticated(username, password);
            this.store.dispatch(PlaylistActions.loadPlaylists());
            return { ok: true };
        } catch {
            return { ok: false, reason: 'storage-error' };
        }
    }

    private async persistConnection(
        username: string,
        password: string
    ): Promise<void> {
        const existing = await firstValueFrom(
            this.playlists.getPlaylistById(ZENPLAY_PLAYLIST_ID)
        );
        const now = new Date().toISOString();

        if (existing) {
            await firstValueFrom(
                this.playlists.transformPlaylistMeta(
                    ZENPLAY_PLAYLIST_ID,
                    (current) => ({
                        ...current,
                        title: ZENPLAY_PLAYLIST_TITLE,
                        serverUrl: ZENPLAY_SERVER_URL,
                        username,
                        password,
                        lastUsage: now,
                        updateDate: Date.now(),
                    })
                )
            );
            return;
        }

        const playlist: Playlist = {
            _id: ZENPLAY_PLAYLIST_ID,
            title: ZENPLAY_PLAYLIST_TITLE,
            serverUrl: ZENPLAY_SERVER_URL,
            username,
            password,
            importDate: now,
            lastUsage: now,
            count: 0,
            autoRefresh: false,
        };
        await firstValueFrom(this.playlists.addPlaylist(playlist));
    }
}
