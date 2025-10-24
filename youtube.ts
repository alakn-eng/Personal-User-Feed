import { google, youtube_v3 } from "googleapis";
import type { Credentials } from "google-auth-library";
import { eq, and, desc } from "drizzle-orm";
import { LibSQLDatabase } from "drizzle-orm/libsql";
import { nanoid } from "nanoid";
import {
  connectedSourcesTable,
  creatorsTable,
  userSubscriptionsTable,
  contentItemsTable,
  ConnectedSource,
  ContentItem,
} from "./schema";

const OAUTH_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"] as const;

// ============================================================================
// TYPES
// ============================================================================

interface YouTubeChannel {
  channelId: string;
  title: string;
  thumbnailUrl?: string | null;
  uploadsPlaylistId?: string | null;
  subscribedAt?: string | null;
}

interface YouTubeVideo {
  videoId: string;
  channelId: string;
  title: string;
  description?: string | null;
  publishedAt: string;
  thumbnailUrl?: string | null;
  duration?: string | null;
}

// ============================================================================
// REPOSITORY (Database operations)
// ============================================================================

export interface YouTubeRepository {
  // Connection management
  saveConnection(
    userId: string,
    tokens: Credentials,
    accountId?: string,
    accountName?: string
  ): Promise<string>;
  getConnection(userId: string): Promise<ConnectedSource | null>;
  updateConnectionTokens(connectionId: string, tokens: Credentials): Promise<void>;
  updateConnectionSync(connectionId: string, syncedAt: string): Promise<void>;

  // Creators (channels) management
  upsertCreators(channels: YouTubeChannel[]): Promise<void>;
  syncUserSubscriptions(
    userId: string,
    connectionId: string,
    channels: YouTubeChannel[]
  ): Promise<void>;

  // Content (videos) management
  upsertVideos(videos: YouTubeVideo[]): Promise<void>;

  // Query content
  getLatestVideos(userId: string, limit: number): Promise<(ContentItem & { creatorName: string })[]>;
}

export function createYouTubeRepository(db: LibSQLDatabase<Record<string, never>>): YouTubeRepository {
  return {
    async saveConnection(userId, tokens, accountId, accountName) {
      const connectionId = nanoid();
      const now = new Date().toISOString();

      await db.insert(connectedSourcesTable).values({
        connectionId,
        userId,
        sourceType: "youtube",
        sourceAccountId: accountId ?? null,
        sourceAccountName: accountName ?? null,
        accessToken: tokens.access_token ?? null,
        refreshToken: tokens.refresh_token ?? null,
        tokenExpiresAt: tokens.expiry_date ?? null,
        metadata: null,
        connectedAt: now,
        lastSyncedAt: now,
        isActive: true,
      });

      return connectionId;
    },

    async getConnection(userId) {
      const rows = await db
        .select()
        .from(connectedSourcesTable)
        .where(
          and(
            eq(connectedSourcesTable.userId, userId),
            eq(connectedSourcesTable.sourceType, "youtube"),
            eq(connectedSourcesTable.isActive, true)
          )
        )
        .limit(1);

      return rows[0] ?? null;
    },

    async updateConnectionTokens(connectionId, tokens) {
      await db
        .update(connectedSourcesTable)
        .set({
          accessToken: tokens.access_token ?? null,
          refreshToken: tokens.refresh_token ?? null,
          tokenExpiresAt: tokens.expiry_date ?? null,
        })
        .where(eq(connectedSourcesTable.connectionId, connectionId));
    },

    async updateConnectionSync(connectionId, syncedAt) {
      await db
        .update(connectedSourcesTable)
        .set({ lastSyncedAt: syncedAt })
        .where(eq(connectedSourcesTable.connectionId, connectionId));
    },

    async upsertCreators(channels) {
      if (!channels.length) return;
      const now = new Date().toISOString();

      for (const channel of channels) {
        const creatorId = `youtube-${channel.channelId}`;

        // Check if creator exists
        const existing = await db
          .select()
          .from(creatorsTable)
          .where(eq(creatorsTable.creatorId, creatorId))
          .limit(1);

        const metadata = channel.uploadsPlaylistId
          ? JSON.stringify({ uploadsPlaylistId: channel.uploadsPlaylistId })
          : null;

        if (existing.length > 0) {
          // Update existing
          await db
            .update(creatorsTable)
            .set({
              name: channel.title,
              avatarUrl: channel.thumbnailUrl ?? null,
              metadata,
              lastUpdatedAt: now,
            })
            .where(eq(creatorsTable.creatorId, creatorId));
        } else {
          // Insert new
          await db.insert(creatorsTable).values({
            creatorId,
            sourceType: "youtube",
            externalId: channel.channelId,
            name: channel.title,
            handle: null,
            bio: null,
            avatarUrl: channel.thumbnailUrl ?? null,
            profileUrl: `https://youtube.com/channel/${channel.channelId}`,
            subscriberCount: null,
            metadata,
            firstSeenAt: now,
            lastUpdatedAt: now,
          });
        }
      }
    },

    async syncUserSubscriptions(userId, connectionId, channels) {
      if (!channels.length) return;
      const now = new Date().toISOString();

      for (const channel of channels) {
        const creatorId = `youtube-${channel.channelId}`;

        // Check if subscription exists
        const existing = await db
          .select()
          .from(userSubscriptionsTable)
          .where(
            and(
              eq(userSubscriptionsTable.userId, userId),
              eq(userSubscriptionsTable.creatorId, creatorId)
            )
          )
          .limit(1);

        if (existing.length === 0) {
          // Insert new subscription
          await db.insert(userSubscriptionsTable).values({
            userId,
            creatorId,
            connectionId,
            subscribedAt: channel.subscribedAt ?? now,
            isActive: true,
            notificationsEnabled: true,
          });
        }
      }
    },

    async upsertVideos(videos) {
      if (!videos.length) return;
      const now = new Date().toISOString();

      for (const video of videos) {
        const contentId = `youtube-${video.videoId}`;
        const creatorId = `youtube-${video.channelId}`;

        // Check if content exists
        const existing = await db
          .select()
          .from(contentItemsTable)
          .where(eq(contentItemsTable.contentId, contentId))
          .limit(1);

        if (existing.length > 0) {
          // Update existing
          await db
            .update(contentItemsTable)
            .set({
              title: video.title,
              description: video.description ?? null,
              thumbnailUrl: video.thumbnailUrl ?? null,
              duration: video.duration ? parseDurationToSeconds(video.duration) : null,
              updatedAt: now,
            })
            .where(eq(contentItemsTable.contentId, contentId));
        } else {
          // Insert new
          await db.insert(contentItemsTable).values({
            contentId,
            creatorId,
            sourceType: "youtube",
            externalId: video.videoId,
            title: video.title,
            description: video.description ?? null,
            contentUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
            thumbnailUrl: video.thumbnailUrl ?? null,
            mediaType: "video",
            duration: video.duration ? parseDurationToSeconds(video.duration) : null,
            wordCount: null,
            publishedAt: video.publishedAt,
            addedAt: now,
            updatedAt: null,
            viewCount: null,
            likeCount: null,
            commentCount: null,
            metadata: null,
            isArchived: false,
            contentHash: null,
          });
        }
      }
    },

    async getLatestVideos(userId, limit) {
      const rows = await db
        .select({
          contentId: contentItemsTable.contentId,
          creatorId: contentItemsTable.creatorId,
          sourceType: contentItemsTable.sourceType,
          externalId: contentItemsTable.externalId,
          title: contentItemsTable.title,
          description: contentItemsTable.description,
          contentUrl: contentItemsTable.contentUrl,
          thumbnailUrl: contentItemsTable.thumbnailUrl,
          mediaType: contentItemsTable.mediaType,
          duration: contentItemsTable.duration,
          wordCount: contentItemsTable.wordCount,
          publishedAt: contentItemsTable.publishedAt,
          addedAt: contentItemsTable.addedAt,
          updatedAt: contentItemsTable.updatedAt,
          viewCount: contentItemsTable.viewCount,
          likeCount: contentItemsTable.likeCount,
          commentCount: contentItemsTable.commentCount,
          metadata: contentItemsTable.metadata,
          isArchived: contentItemsTable.isArchived,
          contentHash: contentItemsTable.contentHash,
          creatorName: creatorsTable.name,
        })
        .from(contentItemsTable)
        .innerJoin(creatorsTable, eq(creatorsTable.creatorId, contentItemsTable.creatorId))
        .innerJoin(
          userSubscriptionsTable,
          and(
            eq(userSubscriptionsTable.creatorId, contentItemsTable.creatorId),
            eq(userSubscriptionsTable.userId, userId),
            eq(userSubscriptionsTable.isActive, true)
          )
        )
        .where(eq(contentItemsTable.sourceType, "youtube"))
        .orderBy(desc(contentItemsTable.publishedAt))
        .limit(limit);

      return rows;
    },
  };
}

// ============================================================================
// OAUTH HELPERS
// ============================================================================

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

export async function refreshAccessToken(connection: ConnectedSource) {
  if (!connection.refreshToken) {
    throw new Error("Missing refresh token for YouTube connection");
  }

  const client = createOAuthClient();
  client.setCredentials({
    access_token: connection.accessToken ?? undefined,
    refresh_token: connection.refreshToken ?? undefined,
    token_type: "Bearer",
    expiry_date: connection.tokenExpiresAt ?? undefined,
  });

  const { credentials } = await client.refreshAccessToken();
  return { client, credentials };
}

// ============================================================================
// YOUTUBE INGESTION SERVICE
// ============================================================================

export class YouTubeIngestionService {
  private readonly youtube: youtube_v3.Youtube;

  constructor(
    private readonly repo: YouTubeRepository,
    private readonly client: youtube_v3.Youtube,
    private readonly userId: string,
    private readonly connectionId: string
  ) {
    this.youtube = client;
  }

  static async fromConnection(repo: YouTubeRepository, userId: string) {
    const connection = await repo.getConnection(userId);
    if (!connection) {
      throw new Error("User has not connected YouTube yet");
    }

    const { client, credentials } = await refreshAccessToken(connection);
    await repo.updateConnectionTokens(connection.connectionId, credentials);

    const youtube = google.youtube({ version: "v3", auth: client });
    return new YouTubeIngestionService(repo, youtube, userId, connection.connectionId);
  }

  async syncUserSubscriptions() {
    const channels: YouTubeChannel[] = [];
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

        channels.push({
          channelId,
          title: item.snippet?.title ?? "Untitled channel",
          thumbnailUrl: item.snippet?.thumbnails?.default?.url,
          uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
          subscribedAt: item.snippet?.publishedAt ?? null,
        });
      }

      nextPageToken = response.data.nextPageToken ?? undefined;
    } while (nextPageToken);

    await this.repo.upsertCreators(channels);
    await this.repo.syncUserSubscriptions(this.userId, this.connectionId, channels);

    return channels;
  }

  async syncUploads(limitPerChannel = 20) {
    const now = new Date().toISOString();

    // Get all channels user is subscribed to
    const channels = await this.getSubscribedChannels();
    console.log(`   Found ${channels.length} subscribed channels`);

    const videos: YouTubeVideo[] = [];

    for (const channel of channels) {
      const playlistId = await this.getUploadsPlaylist(channel.channelId);
      if (!playlistId) {
        console.log(`   ⚠️  No uploads playlist for channel: ${channel.title}`);
        continue;
      }

      const response = await this.youtube.playlistItems.list({
        playlistId,
        part: ["snippet", "contentDetails"],
        maxResults: limitPerChannel,
      });

      const itemCount = response.data.items?.length ?? 0;
      console.log(`   📺 Channel "${channel.title}": ${itemCount} videos`);

      for (const item of response.data.items ?? []) {
        const snippet = item.snippet;
        const contentDetails = item.contentDetails;
        const videoId = contentDetails?.videoId;
        if (!snippet || !videoId) continue;

        videos.push({
          videoId,
          channelId: channel.channelId,
          title: snippet.title ?? "Untitled video",
          description: snippet.description ?? null,
          publishedAt: snippet.publishedAt ?? now,
          thumbnailUrl: snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.default?.url ?? null,
          duration: null, // Would need separate API call to get duration
        });
      }
    }

    console.log(`   💾 Saving ${videos.length} total videos to database`);

    if (videos.length) {
      await this.repo.upsertVideos(videos);
    }

    await this.repo.updateConnectionSync(this.connectionId, now);
  }

  async latestVideos(limit = 5) {
    return this.repo.getLatestVideos(this.userId, limit);
  }

  private async getSubscribedChannels(): Promise<YouTubeChannel[]> {
    const response = await this.youtube.subscriptions.list({
      part: ["snippet", "contentDetails"],
      mine: true,
      maxResults: 50,
    });

    return (response.data.items ?? [])
      .filter((item) => item.snippet?.resourceId?.channelId)
      .map((item) => ({
        channelId: item.snippet!.resourceId!.channelId!,
        title: item.snippet?.title ?? "Untitled",
        thumbnailUrl: item.snippet?.thumbnails?.default?.url,
        uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
        subscribedAt: item.snippet?.publishedAt ?? null,
      }));
  }

  private async getUploadsPlaylist(channelId: string): Promise<string | null> {
    const response = await this.youtube.channels.list({
      id: [channelId],
      part: ["contentDetails"],
    });

    return response.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function parseDurationToSeconds(isoDuration: string): number {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(isoDuration);
  if (!match) return 0;

  const [, hours, minutes, seconds] = match;
  return (parseInt(hours || "0") * 3600) + (parseInt(minutes || "0") * 60) + parseInt(seconds || "0");
}
