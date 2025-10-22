import { google, youtube_v3 } from "googleapis";
import type { Credentials } from "google-auth-library";
import {
  and,
  desc,
  eq,
  inArray,
  notInArray,
} from "drizzle-orm";
import {
  AnySQLiteDatabase,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { InferModel } from "drizzle-orm";

const OAUTH_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"] as const;

export const channelsTable = sqliteTable("channels", {
  channelId: text("channel_id").primaryKey(),
  title: text("title").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  uploadsPlaylistId: text("uploads_playlist_id"),
  subscribedAt: text("subscribed_at"),
  lastCheckedAt: text("last_checked_at"),
});

export const userChannelsTable = sqliteTable(
  "user_channels",
  {
    userId: text("user_id").notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channelsTable.channelId),
    subscribedAt: text("subscribed_at"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.channelId] }),
  })
);

export const videosTable = sqliteTable("videos", {
  videoId: text("video_id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channelsTable.channelId),
  title: text("title").notNull(),
  description: text("description"),
  publishedAt: text("published_at").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  duration: text("duration"),
  addedAt: text("added_at").notNull(),
});

export const userPinsTable = sqliteTable(
  "user_pins",
  {
    userId: text("user_id").notNull(),
    videoId: text("video_id")
      .notNull()
      .references(() => videosTable.videoId),
    note: text("note"),
    pinnedAt: text("pinned_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.videoId] }),
  })
);

export const youtubeTokensTable = sqliteTable(
  "youtube_tokens",
  {
    userId: text("user_id").primaryKey(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    scope: text("scope"),
    tokenType: text("token_type"),
    expiryDate: integer("expiry_date", { mode: "number" }),
  }
);

export type ChannelRow = InferModel<typeof channelsTable>;
export type VideoRow = InferModel<typeof videosTable>;
export type UserPinRow = InferModel<typeof userPinsTable>;
export type YoutubeTokenRow = InferModel<typeof youtubeTokensTable>;

export interface ChannelSubscription {
  channelId: string;
  title: string;
  thumbnailUrl?: string | null;
  uploadsPlaylistId?: string | null;
  subscribedAt?: string | null;
}

export interface UploadVideo {
  videoId: string;
  channelId: string;
  title: string;
  description?: string | null;
  publishedAt: string;
  thumbnailUrl?: string | null;
  duration?: string | null;
}

export interface YoutubeRepository {
  saveTokens(userId: string, tokens: Credentials): Promise<void>;
  getTokens(userId: string): Promise<YoutubeTokenRow | null>;
  upsertChannels(channels: ChannelSubscription[]): Promise<void>;
  syncUserChannels(userId: string, channelIds: ChannelSubscription[]): Promise<void>;
  updateUploadsPlaylist(channelId: string, playlistId: string): Promise<void>;
  listChannelsNeedingPlaylists(channelIds: string[]): Promise<string[]>;
  upsertVideos(videos: UploadVideo[]): Promise<void>;
  markChannelsChecked(channelIds: string[], checkedAt: string): Promise<void>;
  getLatestVideos(userId: string, limit: number): Promise<(VideoRow & { channelTitle: string })[]>;
}

export function createYoutubeRepository(db: AnySQLiteDatabase): YoutubeRepository {
  return {
    async saveTokens(userId, tokens) {
      await db
        .insert(youtubeTokensTable)
        .values({
          userId,
          accessToken: tokens.access_token ?? null,
          refreshToken: tokens.refresh_token ?? null,
          scope: tokens.scope ?? null,
          tokenType: tokens.token_type ?? null,
          expiryDate: tokens.expiry_date ?? null,
        })
        .onConflictDoUpdate({
          target: youtubeTokensTable.userId,
          set: {
            accessToken: tokens.access_token ?? null,
            refreshToken: tokens.refresh_token ?? null,
            scope: tokens.scope ?? null,
            tokenType: tokens.token_type ?? null,
            expiryDate: tokens.expiry_date ?? null,
          },
        });
    },

    async getTokens(userId) {
      const rows = await db
        .select()
        .from(youtubeTokensTable)
        .where(eq(youtubeTokensTable.userId, userId))
        .limit(1);
      return rows.at(0) ?? null;
    },

    async upsertChannels(channels) {
      if (!channels.length) return;
      const now = new Date().toISOString();
      await db
        .insert(channelsTable)
        .values(
          channels.map((channel) => ({
            channelId: channel.channelId,
            title: channel.title,
            thumbnailUrl: channel.thumbnailUrl ?? null,
            uploadsPlaylistId: channel.uploadsPlaylistId ?? null,
            subscribedAt: channel.subscribedAt ?? now,
            lastCheckedAt: now,
          }))
        )
        .onConflictDoUpdate({
          target: channelsTable.channelId,
          set: {
            title: eqExcluded(channelsTable.title),
            thumbnailUrl: eqExcluded(channelsTable.thumbnailUrl),
            uploadsPlaylistId: eqExcluded(channelsTable.uploadsPlaylistId),
            subscribedAt: eqExcluded(channelsTable.subscribedAt),
            lastCheckedAt: eqExcluded(channelsTable.lastCheckedAt),
          },
        });
    },

    async syncUserChannels(userId, subscriptions) {
      const channelIds = subscriptions.map((item) => item.channelId);
      if (channelIds.length) {
        await db
          .insert(userChannelsTable)
          .values(
            subscriptions.map((item) => ({
              userId,
              channelId: item.channelId,
              subscribedAt: item.subscribedAt ?? new Date().toISOString(),
            }))
          )
          .onConflictDoUpdate({
            target: userChannelsTable.pk,
            set: {
              subscribedAt: eqExcluded(userChannelsTable.subscribedAt),
            },
          });
      }

      const existing = await db
        .select({ channelId: userChannelsTable.channelId })
        .from(userChannelsTable)
        .where(eq(userChannelsTable.userId, userId));

      const keep = new Set(channelIds);
      const toRemove = existing
        .map((row) => row.channelId)
        .filter((id) => !keep.has(id));

      if (toRemove.length) {
        await db
          .delete(userChannelsTable)
          .where(
            and(
              eq(userChannelsTable.userId, userId),
              inArray(userChannelsTable.channelId, toRemove)
            )
          );
      }
    },

    async updateUploadsPlaylist(channelId, playlistId) {
      await db
        .update(channelsTable)
        .set({ uploadsPlaylistId: playlistId })
        .where(eq(channelsTable.channelId, channelId));
    },

    async listChannelsNeedingPlaylists(channelIds) {
      if (!channelIds.length) return [];
      const rows = await db
        .select({
          channelId: channelsTable.channelId,
        })
        .from(channelsTable)
        .where(
          and(
            inArray(channelsTable.channelId, channelIds),
            eq(channelsTable.uploadsPlaylistId, null)
          )
        );
      return rows.map((row) => row.channelId);
    },

    async upsertVideos(videos) {
      if (!videos.length) return;
      const now = new Date().toISOString();
      await db
        .insert(videosTable)
        .values(
          videos.map((video) => ({
            videoId: video.videoId,
            channelId: video.channelId,
            title: video.title,
            description: video.description ?? null,
            publishedAt: video.publishedAt,
            thumbnailUrl: video.thumbnailUrl ?? null,
            duration: video.duration ?? null,
            addedAt: now,
          }))
        )
        .onConflictDoUpdate({
          target: videosTable.videoId,
          set: {
            title: eqExcluded(videosTable.title),
            description: eqExcluded(videosTable.description),
            publishedAt: eqExcluded(videosTable.publishedAt),
            thumbnailUrl: eqExcluded(videosTable.thumbnailUrl),
            duration: eqExcluded(videosTable.duration),
          },
        });
    },

    async markChannelsChecked(channelIds, checkedAt) {
      if (!channelIds.length) return;
      await db
        .update(channelsTable)
        .set({ lastCheckedAt: checkedAt })
        .where(inArray(channelsTable.channelId, channelIds));
    },

    async getLatestVideos(userId, limit) {
      const rows = await db
        .select({
          videoId: videosTable.videoId,
          channelId: videosTable.channelId,
          title: videosTable.title,
          description: videosTable.description,
          publishedAt: videosTable.publishedAt,
          thumbnailUrl: videosTable.thumbnailUrl,
          duration: videosTable.duration,
          addedAt: videosTable.addedAt,
          channelTitle: channelsTable.title,
        })
        .from(videosTable)
        .innerJoin(
          userChannelsTable,
          and(
            eq(userChannelsTable.channelId, videosTable.channelId),
            eq(userChannelsTable.userId, userId)
          )
        )
        .innerJoin(channelsTable, eq(channelsTable.channelId, videosTable.channelId))
        .orderBy(desc(videosTable.publishedAt))
        .limit(limit);

      return rows;
    },
  } satisfies YoutubeRepository;
}

function eqExcluded<T>(column: T): T {
  // Helper to satisfy TypeScript when using onConflictDoUpdate.
  return column;
}

function createOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing Google OAuth environment variables");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function createAuthUrl({ state }: { state?: string } = {}) {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: [...OAUTH_SCOPES],
    include_granted_scopes: true,
    prompt: "consent",
    state,
  });
}

export async function exchangeCodeForTokens(code: string) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  return { client, tokens };
}

export async function refreshAccessToken(tokens: YoutubeTokenRow) {
  if (!tokens.refreshToken) {
    throw new Error("Missing refresh token for YouTube account");
  }
  const client = createOAuthClient();
  client.setCredentials({
    access_token: tokens.accessToken ?? undefined,
    refresh_token: tokens.refreshToken ?? undefined,
    scope: tokens.scope ?? undefined,
    token_type: tokens.tokenType ?? undefined,
    expiry_date: tokens.expiryDate ?? undefined,
  });
  const { credentials } = await client.refreshAccessToken();
  return { client, credentials };
}

export class YoutubeIngestionService {
  private readonly youtube: youtube_v3.Youtube;

  constructor(
    private readonly repo: YoutubeRepository,
    private readonly client: youtube_v3.Youtube,
    private readonly userId: string
  ) {
    this.youtube = client;
  }

  static async fromTokens(repo: YoutubeRepository, userId: string) {
    const stored = await repo.getTokens(userId);
    if (!stored) {
      throw new Error("User has not connected YouTube yet");
    }

    const { client, credentials } = await refreshAccessToken(stored);
    await repo.saveTokens(userId, credentials);

    const youtube = google.youtube({ version: "v3", auth: client });
    return new YoutubeIngestionService(repo, youtube, userId);
  }

  async syncUserSubscriptions() {
    const subscriptions: ChannelSubscription[] = [];
    let nextPageToken: string | undefined;

    do {
      const response = await this.youtube.subscriptions.list({
        part: ["snippet", "contentDetails"],
        mine: true,
        maxResults: 50,
        pageToken: nextPageToken,
      });

      const items = response.data.items ?? [];
      for (const item of items) {
        const channelId = item.snippet?.resourceId?.channelId;
        if (!channelId) continue;
        subscriptions.push({
          channelId,
          title: item.snippet?.title ?? "Untitled channel",
          thumbnailUrl: item.snippet?.thumbnails?.default?.url,
          subscribedAt: item.snippet?.publishedAt ?? null,
          uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
        });
      }

      nextPageToken = response.data.nextPageToken ?? undefined;
    } while (nextPageToken);

    await this.repo.upsertChannels(subscriptions);
    await this.repo.syncUserChannels(this.userId, subscriptions);

    const missing = await this.repo.listChannelsNeedingPlaylists(
      subscriptions.map((item) => item.channelId)
    );
    if (missing.length) {
      await this.populateUploadPlaylists(missing);
    }
  }

  async syncUploads(limitPerChannel = 20) {
    const now = new Date().toISOString();
    const subscriptions = await this.repo.getLatestVideos(this.userId, 0);
    const channelIds = subscriptions.map((item) => item.channelId);
    const uniqueIds = Array.from(new Set(channelIds));
    const videos: UploadVideo[] = [];

    for (const channelId of uniqueIds) {
      const playlistId = await this.ensureUploadPlaylist(channelId);
      if (!playlistId) continue;

      const response = await this.youtube.playlistItems.list({
        playlistId,
        part: ["snippet", "contentDetails"],
        maxResults: limitPerChannel,
      });

      for (const item of response.data.items ?? []) {
        const snippet = item.snippet;
        const contentDetails = item.contentDetails;
        const videoId = contentDetails?.videoId;
        if (!snippet || !videoId) continue;
        videos.push({
          videoId,
          channelId,
          title: snippet.title ?? "Untitled video",
          description: snippet.description ?? null,
          publishedAt: snippet.publishedAt ?? now,
          thumbnailUrl: snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.default?.url ?? null,
        });
      }
    }

    if (videos.length) {
      await this.repo.upsertVideos(videos);
    }

    await this.repo.markChannelsChecked(uniqueIds, now);
  }

  async latestVideos(limit = 5) {
    return this.repo.getLatestVideos(this.userId, limit);
  }

  private async ensureUploadPlaylist(channelId: string) {
    const missing = await this.repo.listChannelsNeedingPlaylists([channelId]);
    if (!missing.length) {
      const playlist = await this.getStoredPlaylist(channelId);
      return playlist;
    }

    await this.populateUploadPlaylists([channelId]);
    return this.getStoredPlaylist(channelId);
  }

  private async populateUploadPlaylists(channelIds: string[]) {
    const chunkSize = 50;
    for (let i = 0; i < channelIds.length; i += chunkSize) {
      const chunk = channelIds.slice(i, i + chunkSize);
      const response = await this.youtube.channels.list({
        id: chunk,
        part: ["contentDetails"],
        maxResults: chunk.length,
      });

      for (const item of response.data.items ?? []) {
        const uploads = item.contentDetails?.relatedPlaylists?.uploads;
        const id = item.id;
        if (!uploads || !id) continue;
        await this.repo.updateUploadsPlaylist(id, uploads);
      }
    }
  }

  private async getStoredPlaylist(channelId: string) {
    const rows = await (this.repo as YoutubeRepository & {
      getPlaylistForChannel?: (channelId: string) => Promise<string | null>;
    }).getPlaylistForChannel?.(channelId);
    return rows ?? null;
  }
}

