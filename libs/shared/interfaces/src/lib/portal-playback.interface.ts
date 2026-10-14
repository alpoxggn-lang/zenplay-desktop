import { ChannelDrm } from './channel-drm.interface';
import { PlaybackPositionData } from './playback-position.interface';

export interface PlayerContentInfo extends Omit<
    PlaybackPositionData,
    'positionSeconds' | 'durationSeconds' | 'updatedAt'
> {
    playlistId: string;
}

export interface ResolvedPortalPlayback {
    streamUrl: string;
    /** Direct browser source used once when the adaptive PWA route cannot start. */
    webDirectFallbackUrl?: string;
    /** Source-owner supplied, advertised TS alternative for Xtream live Auto only. */
    liveAutoTsUrl?: string;
    /**
     * Source-owner supplied alternate live transport for Auto mode. Unlike the
     * legacy TS-only field this can point from TS to HLS or from HLS to TS.
     */
    liveAutoFallbackUrl?: string;
    title: string;
    thumbnail?: string | null;
    isLive?: boolean;
    startTime?: number;
    contentInfo?: PlayerContentInfo;
    headers?: Record<string, string>;
    userAgent?: string;
    referer?: string;
    origin?: string;
    drm?: ChannelDrm;
}
