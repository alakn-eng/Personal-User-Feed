import { LibSQLDatabase } from "drizzle-orm/libsql";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  rssSourcesTable,
  creatorsTable,
  contentItemsTable,
  userSubscriptionsTable,
  RssSource,
  ContentItem,
} from "../../schema";
import { discoverFeed, FeedDiscoveryResult } from "./feed-discovery";
import { fetchAndParseFeed, ParsedFeedItem, truncateText } from "./feed-parser";

// ============================================================================
// TYPES
// ============================================================================

export interface RssRepository {
  // Source management
  addSource(
    userId: string,
    siteUrl: string,
    manualFeedUrl?: string
  ): Promise<{ sourceId: string; discovery: FeedDiscoveryResult }>;
  getSource(sourceId: string): Promise<RssSource | null>;
  getUserSources(userId: string): Promise<RssSource[]>;
  updateSourceSync(
    sourceId: string,
    status: "success" | "error",
    error?: string
  ): Promise<void>;
  updateSourceHeaders(sourceId: string, etag?: string, lastModified?: string): Promise<void>;
  removeSource(sourceId: string): Promise<void>;

  // Content management
  upsertCreator(
    feedUrl: string,
    feedTitle: string,
    feedDescription?: string
  ): Promise<string>;
  upsertPosts(creatorId: string, posts: ParsedFeedItem[]): Promise<number>;

  // Query content
  getLatestPosts(userId: string, limit: number): Promise<(ContentItem & { creatorName: string; sourceId: string })[]>;
}

// ============================================================================
// REPOSITORY IMPLEMENTATION
// ============================================================================

export function createRssRepository(db: LibSQLDatabase<Record<string, never>>): RssRepository {
  return {
    async addSource(userId, siteUrl, manualFeedUrl) {
      const now = new Date().toISOString();

      let discovery: FeedDiscoveryResult;

      if (manualFeedUrl) {
        // Manual feed URL provided
        console.log(`[RSS] Manual feed URL provided: ${manualFeedUrl}`);

        // Basic validation - try to fetch it
        const result = await fetchAndParseFeed(manualFeedUrl, "rss"); // Assume RSS, parser will handle
        if (!result) {
          throw new Error(`Invalid feed URL: ${manualFeedUrl}`);
        }

        discovery = {
          feedUrl: manualFeedUrl,
          feedType: result.feedType,
          discoveryMethod: "manual",
          feedTitle: result.feed.title,
          feedDescription: result.feed.description,
          siteUrl: siteUrl,
        };

        console.log(`✅ [RSS] Manual feed validated: ${manualFeedUrl}`);
      } else {
        // Auto-discover feed
        console.log(`[RSS] Auto-discovering feed for: ${siteUrl}`);
        discovery = await discoverFeed(siteUrl);
      }

      // Create source record
      const sourceId = nanoid();
      await db.insert(rssSourcesTable).values({
        sourceId,
        userId,
        siteUrl: discovery.siteUrl,
        feedUrl: discovery.feedUrl,
        feedType: discovery.feedType,
        feedTitle: discovery.feedTitle || null,
        feedDescription: discovery.feedDescription || null,
        discoveryMethod: discovery.discoveryMethod,
        discoveryAttemptedAt: now,
        etag: null,
        lastModified: null,
        lastCheckedAt: null,
        lastSyncedAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        addedAt: now,
        isActive: true,
      });

      console.log(
        `✅ [RSS] Added source (${discovery.discoveryMethod}): ${discovery.feedUrl}`
      );

      return { sourceId, discovery };
    },

    async getSource(sourceId) {
      const rows = await db
        .select()
        .from(rssSourcesTable)
        .where(eq(rssSourcesTable.sourceId, sourceId))
        .limit(1);

      return rows[0] || null;
    },

    async getUserSources(userId) {
      return await db
        .select()
        .from(rssSourcesTable)
        .where(and(eq(rssSourcesTable.userId, userId), eq(rssSourcesTable.isActive, true)))
        .orderBy(desc(rssSourcesTable.addedAt));
    },

    async updateSourceSync(sourceId, status, error) {
      const now = new Date().toISOString();

      await db
        .update(rssSourcesTable)
        .set({
          lastCheckedAt: now,
          lastSyncedAt: status === "success" ? now : undefined,
          lastSyncStatus: status,
          lastSyncError: error || null,
        })
        .where(eq(rssSourcesTable.sourceId, sourceId));
    },

    async updateSourceHeaders(sourceId, etag, lastModified) {
      await db
        .update(rssSourcesTable)
        .set({
          etag: etag || null,
          lastModified: lastModified || null,
        })
        .where(eq(rssSourcesTable.sourceId, sourceId));
    },

    async removeSource(sourceId) {
      await db
        .update(rssSourcesTable)
        .set({ isActive: false })
        .where(eq(rssSourcesTable.sourceId, sourceId));
    },

    async upsertCreator(feedUrl, feedTitle, feedDescription) {
      const now = new Date().toISOString();

      // Use feed URL as the external ID (unique per feed)
      const externalId = feedUrl;

      // Check if creator already exists
      const existing = await db
        .select()
        .from(creatorsTable)
        .where(
          and(
            eq(creatorsTable.sourceType, "rss"),
            eq(creatorsTable.externalId, externalId)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        // Update existing
        const creatorId = existing[0].creatorId;
        await db
          .update(creatorsTable)
          .set({
            name: feedTitle,
            bio: feedDescription || null,
            lastUpdatedAt: now,
          })
          .where(eq(creatorsTable.creatorId, creatorId));

        return creatorId;
      }

      // Create new creator
      const creatorId = `rss-${nanoid()}`;
      await db.insert(creatorsTable).values({
        creatorId,
        sourceType: "rss",
        externalId,
        name: feedTitle,
        handle: null,
        bio: feedDescription || null,
        avatarUrl: null,
        profileUrl: feedUrl,
        subscriberCount: null,
        metadata: null,
        firstSeenAt: now,
        lastUpdatedAt: now,
      });

      return creatorId;
    },

    async upsertPosts(creatorId, posts) {
      const now = new Date().toISOString();
      let newPostsCount = 0;

      for (const post of posts) {
        // Check if post already exists (by hash or external ID)
        const existing = await db
          .select()
          .from(contentItemsTable)
          .where(
            and(
              eq(contentItemsTable.sourceType, "rss"),
              eq(contentItemsTable.contentHash, post.hash)
            )
          )
          .limit(1);

        if (existing.length > 0) {
          // Post already exists - skip or update if edited
          const existingPost = existing[0];

          // Check if content was updated (compare hashes)
          if (existingPost.contentHash !== post.hash) {
            console.log(`[RSS] Updating edited post: ${post.title}`);
            await db
              .update(contentItemsTable)
              .set({
                title: post.title,
                description: truncateText(post.description || "", 500),
                contentHash: post.hash,
                updatedAt: now,
              })
              .where(eq(contentItemsTable.contentId, existingPost.contentId));
          }

          continue;
        }

        // Insert new post
        const contentId = nanoid();
        await db.insert(contentItemsTable).values({
          contentId,
          creatorId,
          sourceType: "rss",
          externalId: post.guid || post.url,
          title: post.title,
          description: truncateText(post.description || "", 500),
          contentUrl: post.url,
          thumbnailUrl: null,
          mediaType: "article",
          duration: null,
          wordCount: null, // TODO: could calculate from contentHtml
          publishedAt: post.publishedAt,
          addedAt: now,
          updatedAt: null,
          viewCount: null,
          likeCount: null,
          commentCount: null,
          metadata: JSON.stringify({
            author: post.author,
            contentHtml: post.contentHtml,
          }),
          isArchived: false,
          contentHash: post.hash,
        });

        newPostsCount++;
        console.log(`[RSS] Added new post: ${post.title}`);
      }

      return newPostsCount;
    },

    async getLatestPosts(userId, limit) {
      // Get all RSS sources for this user
      console.log(`[RSS Repo] Fetching sources for ${userId}`);
      const userSources = await db
        .select()
        .from(rssSourcesTable)
        .where(and(eq(rssSourcesTable.userId, userId), eq(rssSourcesTable.isActive, true)));
      console.log(`[RSS Repo] Found ${userSources.length} sources for ${userId}`);

      if (userSources.length === 0) {
        return [];
      }

      // Create a map of feedUrl -> sourceId for quick lookup
      const feedUrlToSourceId = new Map(userSources.map(s => [s.feedUrl, s.sourceId]));

      // Get latest posts from RSS creators
      console.log(`[RSS Repo] Querying latest posts with limit ${limit}`);
      const posts = await db
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
          creatorExternalId: creatorsTable.externalId, // This is the feedUrl
        })
        .from(contentItemsTable)
        .innerJoin(creatorsTable, eq(creatorsTable.creatorId, contentItemsTable.creatorId))
        .where(eq(contentItemsTable.sourceType, "rss"))
        .orderBy(desc(contentItemsTable.publishedAt))
        .limit(limit * 2); // Get more, then filter to active sources
      console.log(`[RSS Repo] Retrieved ${posts.length} raw RSS posts`);

      // Filter to only posts from active sources and add sourceId
      const filteredPosts = posts
        .filter(post => feedUrlToSourceId.has(post.creatorExternalId))
        .slice(0, limit)
        .map(post => ({
          ...post,
          sourceId: feedUrlToSourceId.get(post.creatorExternalId)!,
        }));

      return filteredPosts;
    },
  };
}

// ============================================================================
// RSS INGESTION SERVICE
// ============================================================================

export class RssIngestionService {
  constructor(
    private repo: RssRepository,
    private userId: string
  ) {}

  /**
   * Adds a new RSS/blog source for the user
   */
  async addBlogSource(siteUrl: string, manualFeedUrl?: string): Promise<string> {
    const { sourceId, discovery } = await this.repo.addSource(
      this.userId,
      siteUrl,
      manualFeedUrl
    );

    // Create creator for this feed
    const creatorId = await this.repo.upsertCreator(
      discovery.feedUrl,
      discovery.feedTitle || "Untitled Blog",
      discovery.feedDescription
    );

    // Sync initial posts
    await this.syncSource(sourceId);

    return sourceId;
  }

  /**
   * Syncs a single source (fetches new posts)
   */
  async syncSource(sourceId: string): Promise<void> {
    const source = await this.repo.getSource(sourceId);
    if (!source || !source.isActive) {
      throw new Error(`Source not found or inactive: ${sourceId}`);
    }

    console.log(`[RSS Sync] Syncing source: ${source.feedUrl}`);

    try {
      // Fetch feed with conditional headers
      const result = await fetchAndParseFeed(
        source.feedUrl,
        source.feedType as "rss" | "atom" | "json_feed",
        {
          etag: source.etag || undefined,
          lastModified: source.lastModified || undefined,
        }
      );

      // No new content (304)
      if (!result) {
        console.log(`[RSS Sync] No new content for: ${source.feedUrl}`);
        await this.repo.updateSourceSync(sourceId, "success");
        return;
      }

      // Update headers
      await this.repo.updateSourceHeaders(sourceId, result.etag, result.lastModified);

      // Get or create creator
      const creatorId = await this.repo.upsertCreator(
        source.feedUrl,
        result.feed.title || source.feedTitle || "Untitled Blog",
        result.feed.description || source.feedDescription
      );

      // Upsert posts
      const newPostsCount = await this.repo.upsertPosts(creatorId, result.feed.items);

      console.log(
        `✅ [RSS Sync] Synced ${newPostsCount} new posts from: ${source.feedUrl}`
      );

      await this.repo.updateSourceSync(sourceId, "success");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(`[RSS Sync] Error syncing ${source.feedUrl}:`, errorMessage);
      await this.repo.updateSourceSync(sourceId, "error", errorMessage);
      throw error;
    }
  }

  /**
   * Syncs all sources for this user
   */
  async syncAllSources(): Promise<void> {
    const sources = await this.repo.getUserSources(this.userId);
    console.log(`[RSS Sync] Syncing ${sources.length} sources for user ${this.userId}`);

    for (const source of sources) {
      try {
        await this.syncSource(source.sourceId);
      } catch (error) {
        console.error(`[RSS Sync] Failed to sync ${source.feedUrl}:`, error);
        // Continue with next source
      }
    }

    console.log(`✅ [RSS Sync] Completed sync for user ${this.userId}`);
  }

  /**
   * Gets latest posts from all user's RSS sources
   */
  async getLatestPosts(limit: number = 20): Promise<(ContentItem & { creatorName: string; sourceId: string })[]> {
    return await this.repo.getLatestPosts(this.userId, limit);
  }

  /**
   * Removes a source
   */
  async removeSource(sourceId: string): Promise<void> {
    await this.repo.removeSource(sourceId);
    console.log(`[RSS] Removed source: ${sourceId}`);
  }
}
