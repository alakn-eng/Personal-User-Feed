import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";
import { InferModel } from "drizzle-orm";

// ============================================================================
// USERS & AUTHENTICATION
// ============================================================================

export const usersTable = sqliteTable("users", {
  userId: text("user_id").primaryKey(), // Phone number hash or Magic.link DID
  email: text("email"),
  phoneNumber: text("phone_number"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull(),
  lastLoginAt: text("last_login_at"),
});

// ============================================================================
// CONTENT SOURCES & CONNECTIONS
// ============================================================================

// Tracks which external services a user has connected
// Examples: YouTube account, Substack account, Twitter account
export const connectedSourcesTable = sqliteTable(
  "connected_sources",
  {
    connectionId: text("connection_id").primaryKey(), // UUID
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(), // 'youtube' | 'substack' | 'twitter' | 'rss' | 'custom'
    sourceAccountId: text("source_account_id"), // Their account ID on that platform
    sourceAccountName: text("source_account_name"), // Display name
    accessToken: text("access_token"), // Encrypted OAuth token
    refreshToken: text("refresh_token"), // Encrypted refresh token
    tokenExpiresAt: integer("token_expires_at"), // Unix timestamp
    metadata: text("metadata"), // JSON string for source-specific data
    connectedAt: text("connected_at").notNull(),
    lastSyncedAt: text("last_synced_at"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  },
  (table) => ({
    userIdx: index("connected_sources_user_idx").on(table.userId),
    sourceTypeIdx: index("connected_sources_type_idx").on(table.sourceType),
  })
);

// ============================================================================
// CREATORS (People/Channels users follow)
// ============================================================================

export const creatorsTable = sqliteTable(
  "creators",
  {
    creatorId: text("creator_id").primaryKey(), // UUID
    sourceType: text("source_type").notNull(), // 'youtube' | 'substack' | 'twitter' | 'rss'
    externalId: text("external_id").notNull(), // Platform's ID (channel ID, author ID, user ID, RSS URL)
    name: text("name").notNull(),
    handle: text("handle"), // @username or URL slug
    bio: text("bio"),
    avatarUrl: text("avatar_url"),
    profileUrl: text("profile_url"),
    subscriberCount: integer("subscriber_count"),
    metadata: text("metadata"), // JSON for source-specific fields (e.g., uploads_playlist_id for YouTube)
    firstSeenAt: text("first_seen_at").notNull(),
    lastUpdatedAt: text("last_updated_at"),
  },
  (table) => ({
    externalIdx: index("creators_external_idx").on(table.sourceType, table.externalId),
  })
);

// ============================================================================
// USER SUBSCRIPTIONS (Which creators each user follows)
// ============================================================================

export const userSubscriptionsTable = sqliteTable(
  "user_subscriptions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creatorsTable.creatorId, { onDelete: "cascade" }),
    connectionId: text("connection_id").references(() => connectedSourcesTable.connectionId, {
      onDelete: "set null",
    }), // Which account connection this came from
    subscribedAt: text("subscribed_at").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    notificationsEnabled: integer("notifications_enabled", { mode: "boolean" }).default(true),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.creatorId] }),
    userIdx: index("user_subscriptions_user_idx").on(table.userId),
    creatorIdx: index("user_subscriptions_creator_idx").on(table.creatorId),
  })
);

// ============================================================================
// CONTENT ITEMS (All posts/videos/tweets/articles)
// ============================================================================

export const contentItemsTable = sqliteTable(
  "content_items",
  {
    contentId: text("content_id").primaryKey(), // UUID
    creatorId: text("creator_id")
      .notNull()
      .references(() => creatorsTable.creatorId, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(), // 'youtube' | 'substack' | 'twitter' | 'rss' | 'blog'
    externalId: text("external_id").notNull(), // Platform's content ID (video ID, post ID, tweet ID, article URL)

    // Content fields
    title: text("title").notNull(),
    description: text("description"), // Snippet, body preview, or full text
    contentUrl: text("content_url").notNull(), // Link to original content

    // Media
    thumbnailUrl: text("thumbnail_url"),
    mediaType: text("media_type"), // 'video' | 'article' | 'image' | 'audio' | 'text'
    duration: integer("duration"), // In seconds (for videos/audio)
    wordCount: integer("word_count"), // For articles

    // Timestamps
    publishedAt: text("published_at").notNull(),
    addedAt: text("added_at").notNull(), // When we first saw it
    updatedAt: text("updated_at"), // If content was edited

    // Engagement (optional - can be synced periodically)
    viewCount: integer("view_count"),
    likeCount: integer("like_count"),
    commentCount: integer("comment_count"),

    // Source-specific data stored as JSON
    metadata: text("metadata"), // e.g., YouTube: category, tags; Twitter: retweet info; Substack: paywall status

    // Quality/filtering
    isArchived: integer("is_archived", { mode: "boolean" }).default(false),
    contentHash: text("content_hash"), // For deduplication
  },
  (table) => ({
    creatorIdx: index("content_creator_idx").on(table.creatorId),
    publishedIdx: index("content_published_idx").on(table.publishedAt),
    sourceTypeIdx: index("content_source_type_idx").on(table.sourceType),
    externalIdx: index("content_external_idx").on(table.sourceType, table.externalId),
  })
);

// ============================================================================
// USER INTERACTIONS
// ============================================================================

// Track what content users have read/watched
export const userReadStatusTable = sqliteTable(
  "user_read_status",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    contentId: text("content_id")
      .notNull()
      .references(() => contentItemsTable.contentId, { onDelete: "cascade" }),
    readAt: text("read_at").notNull(),
    progressPercent: integer("progress_percent"), // For videos: how much watched
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.contentId] }),
    userIdx: index("read_status_user_idx").on(table.userId),
  })
);

// User-pinned content
export const userPinsTable = sqliteTable(
  "user_pins",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    contentId: text("content_id")
      .notNull()
      .references(() => contentItemsTable.contentId, { onDelete: "cascade" }),
    note: text("note"),
    pinnedAt: text("pinned_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.contentId] }),
    userIdx: index("pins_user_idx").on(table.userId),
  })
);

// User saved/bookmarked content
export const userSavesTable = sqliteTable(
  "user_saves",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    contentId: text("content_id")
      .notNull()
      .references(() => contentItemsTable.contentId, { onDelete: "cascade" }),
    savedAt: text("saved_at").notNull(),
    collectionName: text("collection_name"), // Optional: organize saves into collections
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.contentId] }),
    userIdx: index("saves_user_idx").on(table.userId),
  })
);

// ============================================================================
// FEED PREFERENCES & CURATION
// ============================================================================

// User preferences for feed algorithm and display
export const userPreferencesTable = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => usersTable.userId, { onDelete: "cascade" }),

  // Feed ordering preferences
  defaultSortOrder: text("default_sort_order").default("newest"), // 'newest' | 'oldest' | 'trending' | 'curated'
  defaultFilterType: text("default_filter_type").default("all"), // 'all' | 'reading' | 'watching' | 'pinned'

  // Display preferences
  itemsPerPage: integer("items_per_page").default(20),
  autoMarkAsRead: integer("auto_mark_as_read", { mode: "boolean" }).default(false),

  // Sync preferences
  syncFrequencyMinutes: integer("sync_frequency_minutes").default(360), // Default: 6 hours

  // Notification preferences
  emailDigestEnabled: integer("email_digest_enabled", { mode: "boolean" }).default(false),
  emailDigestFrequency: text("email_digest_frequency"), // 'daily' | 'weekly' | 'never'

  updatedAt: text("updated_at").notNull(),
});

// ============================================================================
// SYNC JOBS (Track background sync operations)
// ============================================================================

export const syncJobsTable = sqliteTable(
  "sync_jobs",
  {
    jobId: text("job_id").primaryKey(),
    userId: text("user_id").references(() => usersTable.userId, { onDelete: "cascade" }),
    connectionId: text("connection_id").references(() => connectedSourcesTable.connectionId, {
      onDelete: "cascade",
    }),
    sourceType: text("source_type").notNull(),
    status: text("status").notNull(), // 'pending' | 'running' | 'completed' | 'failed'
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    itemsProcessed: integer("items_processed").default(0),
    errorMessage: text("error_message"),
  },
  (table) => ({
    statusIdx: index("sync_jobs_status_idx").on(table.status),
    userIdx: index("sync_jobs_user_idx").on(table.userId),
  })
);

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type User = InferModel<typeof usersTable>;
export type ConnectedSource = InferModel<typeof connectedSourcesTable>;
export type Creator = InferModel<typeof creatorsTable>;
export type UserSubscription = InferModel<typeof userSubscriptionsTable>;
export type ContentItem = InferModel<typeof contentItemsTable>;
export type UserReadStatus = InferModel<typeof userReadStatusTable>;
export type UserPin = InferModel<typeof userPinsTable>;
export type UserSave = InferModel<typeof userSavesTable>;
export type UserPreferences = InferModel<typeof userPreferencesTable>;
export type SyncJob = InferModel<typeof syncJobsTable>;
