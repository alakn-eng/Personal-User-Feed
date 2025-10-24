import { google } from "googleapis";
import { LibSQLDatabase } from "drizzle-orm/libsql";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import crypto from "crypto";
import {
  gmailProcessedMessagesTable,
  creatorsTable,
  contentItemsTable,
  userSubscriptionsTable,
} from "../../schema";
import { createGmailRepository, refreshGmailAccessToken } from "./auth-google";
import type { GmailRepository } from "./auth-google";

// ============================================================================
// TYPES
// ============================================================================

interface SubstackPost {
  messageId: string;
  author: string;
  authorEmail: string;
  title: string;
  postUrl: string;
  snippet: string;
  publishedAt: string;
  htmlContent: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    parts?: Array<{
      mimeType: string;
      body: { data?: string };
    }>;
    body?: { data?: string };
  };
  internalDate?: string;
  snippet?: string;
}

// ============================================================================
// GMAIL INGESTION SERVICE
// ============================================================================

export class GmailIngestionService {
  constructor(
    private readonly db: LibSQLDatabase<Record<string, never>>,
    private readonly gmailRepo: GmailRepository,
    private readonly userId: string,
    private readonly gmailConnectionId: string,
    private readonly useMock: boolean = false
  ) {}

  /**
   * Creates service from stored Gmail connection
   */
  static async fromConnection(
    db: LibSQLDatabase<Record<string, never>>,
    userId: string,
    useMock: boolean = false
  ) {
    const gmailRepo = createGmailRepository(db);
    const connection = await gmailRepo.getConnection(userId);

    if (!connection) {
      throw new Error("User has not connected Gmail yet");
    }

    return new GmailIngestionService(
      db,
      gmailRepo,
      userId,
      connection.gmailConnectionId,
      useMock
    );
  }

  /**
   * Fetches messages from Gmail or mock fixture
   */
  private async fetchMessages(): Promise<GmailMessage[]> {
    // Use mock data if MOCK_GMAIL=on
    if (this.useMock || process.env.MOCK_GMAIL === "on") {
      console.log("📧 Using mock Gmail data from fixture");
      const fs = await import("fs/promises");
      const fixture = await fs.readFile(
        "./dev-fixtures/substack-sample.json",
        "utf-8"
      );
      const data = JSON.parse(fixture);
      return data.messages;
    }

    // Fetch from real Gmail API
    const connection = await this.gmailRepo.getConnection(this.userId);
    if (!connection) {
      throw new Error("Gmail connection not found");
    }

    // Refresh tokens if needed
    const { client } = await refreshGmailAccessToken(
      connection.encryptedAccessToken,
      connection.encryptedRefreshToken,
      connection.tokenExpiresAt
    );

    const gmail = google.gmail({ version: "v1", auth: client });

    // Search for Substack emails (from any @*.substack.com address)
    const listResponse = await gmail.users.messages.list({
      userId: "me",
      q: "from:*@substack.com newer_than:30d", // Last 30 days, any substack domain
      maxResults: 100, // Increased from 50
    });

    const messageIds = listResponse.data.messages?.map((m) => m.id!) || [];
    console.log(`📧 Gmail search found ${messageIds.length} potential Substack emails`);

    // Fetch full message details
    const messages: GmailMessage[] = [];
    for (const id of messageIds) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });
      messages.push(msg.data as GmailMessage);
    }

    return messages;
  }

  /**
   * Parses a Gmail message to extract Substack post data
   */
  private parseSubstackPost(message: GmailMessage): SubstackPost | null {
    try {
      const headers = message.payload.headers;
      const from = headers.find((h) => h.name.toLowerCase() === "from")?.value || "";
      const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value || "Untitled";
      const date = headers.find((h) => h.name.toLowerCase() === "date")?.value || "";

      // Extract author name and email
      const fromMatch = from.match(/^(.*?)\s*<(.+?)>$/);
      const author = fromMatch ? fromMatch[1].trim() : from;
      const authorEmail = fromMatch ? fromMatch[2].trim() : from;

      // Get HTML body
      let htmlContent = "";
      const parts = message.payload.parts || [];

      // Try parts first
      for (const part of parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
          htmlContent = Buffer.from(part.body.data, "base64").toString("utf-8");
          break;
        }
      }

      // Fallback to direct body
      if (!htmlContent && message.payload.body?.data) {
        htmlContent = Buffer.from(message.payload.body.data, "base64").toString("utf-8");
      }

      if (!htmlContent) {
        console.log(`⚠️  No HTML content found in message ${message.id}`);
        return null;
      }

      // Extract Substack post URL from HTML
      // Find ALL URLs and filter for Substack post URLs
      const allUrls = htmlContent.match(/https?:\/\/[^\s"'<>]+/g) || [];

      let postUrl: string | null = null;

      for (const url of allUrls) {
        // Skip tracking pixels, CDN, and generic links
        if (url.includes('substackcdn.com') ||
            url.includes('/image/') ||
            url.includes('substack.com/@') ||
            url.includes('open.substack.com/live-stream')) {
          continue;
        }

        // Check for direct post URL (e.g., https://newsletter.substack.com/p/title)
        if (url.match(/https?:\/\/[^\/]+\.substack\.com\/p\/[^?&#]+/)) {
          postUrl = url.split('?')[0]; // Remove query params
          console.log(`📝 Found direct post URL: ${postUrl.substring(0, 60)}...`);
          break;
        }

        // Check for app-link URL (e.g., https://substack.com/app-link/post?publication_id=...)
        if (url.includes('substack.com/app-link/post?') && url.includes('post_id=')) {
          postUrl = url; // Keep full URL with parameters - Substack needs them
          console.log(`📱 Found app-link URL with post_id`);
          break;
        }
      }

      // Fallback to redirect URLs if no other URL found
      if (!postUrl) {
        const redirectUrlMatch = htmlContent.match(/https:\/\/substack\.com\/redirect\/\d+\/[A-Za-z0-9+/=]+/);
        if (redirectUrlMatch) {
          postUrl = redirectUrlMatch[0];
          console.log(`🔗 Using redirect URL (no direct URL found)`);
        }
      }

      if (!postUrl) {
        console.log(`⚠️  No Substack post URL found in message ${message.id}`);
        return null;
      }

      return {
        messageId: message.id,
        author,
        authorEmail,
        title: subject,
        postUrl,
        snippet: message.snippet || "",
        publishedAt: message.internalDate
          ? new Date(parseInt(message.internalDate)).toISOString()
          : new Date(date).toISOString(),
        htmlContent,
      };
    } catch (error) {
      console.error(`Error parsing message ${message.id}:`, error);
      return null;
    }
  }

  /**
   * Generates content hash for deduplication
   */
  private generateContentHash(post: SubstackPost): string {
    const data = `${post.postUrl}:${post.title}:${post.author}`;
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  /**
   * Checks if message has already been processed
   */
  private async isMessageProcessed(messageId: string): Promise<boolean> {
    const existing = await this.db
      .select()
      .from(gmailProcessedMessagesTable)
      .where(eq(gmailProcessedMessagesTable.messageId, messageId))
      .limit(1);

    return existing.length > 0;
  }

  /**
   * Main ingestion method - processes Substack emails from Gmail
   */
  async ingestSubstackPosts(): Promise<{ processed: number; skipped: number }> {
    const messages = await this.fetchMessages();
    let processed = 0;
    let skipped = 0;

    console.log(`📧 Processing ${messages.length} Gmail messages`);

    for (const message of messages) {
      // Check if already processed
      if (await this.isMessageProcessed(message.id)) {
        console.log(`⏭️  Skipping already processed message: ${message.id}`);
        skipped++;
        continue;
      }

      // Parse Substack post
      const post = this.parseSubstackPost(message);
      if (!post) {
        console.log(`⏭️  Skipping message ${message.id} - could not parse Substack post`);
        skipped++;
        continue;
      }

      console.log(`📝 Processing: "${post.title}" by ${post.author}`);

      // Generate content hash
      const contentHash = this.generateContentHash(post);

      // Check for duplicate content
      const existingByHash = await this.db
        .select()
        .from(gmailProcessedMessagesTable)
        .where(eq(gmailProcessedMessagesTable.contentHash, contentHash))
        .limit(1);

      if (existingByHash.length > 0) {
        console.log(`⏭️  Duplicate content detected (hash match)`);

        // Still mark this message as processed
        await this.db.insert(gmailProcessedMessagesTable).values({
          messageId: message.id,
          userId: this.userId,
          gmailConnectionId: this.gmailConnectionId,
          contentHash,
          processedAt: new Date().toISOString(),
          substackAuthor: post.author,
          substackPostUrl: post.postUrl,
          contentId: existingByHash[0].contentId,
        });

        skipped++;
        continue;
      }

      // Create or update creator
      const creatorId = `substack-${post.authorEmail.replace(/[^a-zA-Z0-9]/g, "-")}`;
      await this.upsertCreator(creatorId, post);

      // Create content item
      const contentId = await this.createContentItem(creatorId, post);

      // Mark message as processed
      await this.db.insert(gmailProcessedMessagesTable).values({
        messageId: message.id,
        userId: this.userId,
        gmailConnectionId: this.gmailConnectionId,
        contentHash,
        processedAt: new Date().toISOString(),
        substackAuthor: post.author,
        substackPostUrl: post.postUrl,
        contentId,
      });

      // Create user subscription if doesn't exist
      await this.ensureSubscription(creatorId);

      processed++;
      console.log(`✅ Saved: ${post.title}`);
    }

    // Update last sync time
    const now = new Date().toISOString();
    await this.gmailRepo.updateConnectionSync(this.gmailConnectionId, now);

    console.log(`📊 Ingestion complete: ${processed} new, ${skipped} skipped`);
    return { processed, skipped };
  }

  /**
   * Creates or updates a Substack creator
   */
  private async upsertCreator(creatorId: string, post: SubstackPost): Promise<void> {
    const now = new Date().toISOString();

    // Extract Substack subdomain from post URL
    const urlMatch = post.postUrl.match(/https?:\/\/([^\/]+)\.substack\.com/);
    const handle = urlMatch ? urlMatch[1] : null;
    const profileUrl = handle ? `https://${handle}.substack.com` : post.postUrl;

    const existing = await this.db
      .select()
      .from(creatorsTable)
      .where(eq(creatorsTable.creatorId, creatorId))
      .limit(1);

    if (existing.length > 0) {
      // Update existing
      await this.db
        .update(creatorsTable)
        .set({
          name: post.author,
          lastUpdatedAt: now,
        })
        .where(eq(creatorsTable.creatorId, creatorId));
    } else {
      // Insert new
      await this.db.insert(creatorsTable).values({
        creatorId,
        sourceType: "substack",
        externalId: post.authorEmail,
        name: post.author,
        handle,
        bio: null,
        avatarUrl: null,
        profileUrl,
        subscriberCount: null,
        metadata: null,
        firstSeenAt: now,
        lastUpdatedAt: now,
      });
    }
  }

  /**
   * Creates a content item for a Substack post
   */
  private async createContentItem(creatorId: string, post: SubstackPost): Promise<string> {
    const now = new Date().toISOString();
    const contentId = `substack-${nanoid()}`;

    await this.db.insert(contentItemsTable).values({
      contentId,
      creatorId,
      sourceType: "substack",
      externalId: post.postUrl,
      title: post.title,
      description: post.snippet,
      contentUrl: post.postUrl,
      thumbnailUrl: null,
      mediaType: "article",
      duration: null,
      wordCount: null,
      publishedAt: post.publishedAt,
      addedAt: now,
      updatedAt: null,
      viewCount: null,
      likeCount: null,
      commentCount: null,
      metadata: JSON.stringify({ htmlContent: post.htmlContent }),
      isArchived: false,
      contentHash: this.generateContentHash(post),
    });

    return contentId;
  }

  /**
   * Ensures user is subscribed to creator
   */
  private async ensureSubscription(creatorId: string): Promise<void> {
    const existing = await this.db
      .select()
      .from(userSubscriptionsTable)
      .where(
        and(
          eq(userSubscriptionsTable.userId, this.userId),
          eq(userSubscriptionsTable.creatorId, creatorId)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      await this.db.insert(userSubscriptionsTable).values({
        userId: this.userId,
        creatorId,
        connectionId: null, // Gmail connections stored separately in gmail_connections table
        subscribedAt: new Date().toISOString(),
        isActive: true,
        notificationsEnabled: true,
      });
    }
  }
}
