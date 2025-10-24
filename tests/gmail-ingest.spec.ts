import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import {
  usersTable,
  gmailConnectionsTable,
  gmailProcessedMessagesTable,
  creatorsTable,
  contentItemsTable,
  userSubscriptionsTable,
} from "../schema";
import { GmailIngestionService, createGmailRepository } from "../src/gmail";
import { encrypt } from "../src/gmail/crypto";

// ============================================================================
// TEST SETUP
// ============================================================================

// Use in-memory SQLite for tests
const testClient = createClient({
  url: ":memory:",
});

const db = drizzle(testClient);

// Mock encryption key for tests
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.MOCK_GMAIL = "on"; // Use mock fixture

// ============================================================================
// TEST DATABASE INITIALIZATION
// ============================================================================

async function initTestDatabase() {
  // Create tables
  await testClient.execute(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email TEXT,
      phone_number TEXT,
      display_name TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `);

  await testClient.execute(`
    CREATE TABLE IF NOT EXISTS gmail_connections (
      gmail_connection_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      gmail_address TEXT NOT NULL,
      encrypted_access_token TEXT NOT NULL,
      encrypted_refresh_token TEXT NOT NULL,
      token_expires_at INTEGER,
      connected_at TEXT NOT NULL,
      last_synced_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )
  `);

  await testClient.execute(`
    CREATE TABLE IF NOT EXISTS gmail_processed_messages (
      message_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      gmail_connection_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      substack_author TEXT,
      substack_post_url TEXT,
      content_id TEXT,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (gmail_connection_id) REFERENCES gmail_connections(gmail_connection_id) ON DELETE CASCADE
    )
  `);

  await testClient.execute(`
    CREATE TABLE IF NOT EXISTS creators (
      creator_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      handle TEXT,
      bio TEXT,
      avatar_url TEXT,
      profile_url TEXT,
      subscriber_count INTEGER,
      metadata TEXT,
      first_seen_at TEXT NOT NULL,
      last_updated_at TEXT
    )
  `);

  await testClient.execute(`
    CREATE TABLE IF NOT EXISTS content_items (
      content_id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      content_url TEXT NOT NULL,
      thumbnail_url TEXT,
      media_type TEXT,
      duration INTEGER,
      word_count INTEGER,
      published_at TEXT NOT NULL,
      added_at TEXT NOT NULL,
      updated_at TEXT,
      view_count INTEGER,
      like_count INTEGER,
      comment_count INTEGER,
      metadata TEXT,
      is_archived INTEGER DEFAULT 0,
      content_hash TEXT,
      FOREIGN KEY (creator_id) REFERENCES creators(creator_id) ON DELETE CASCADE
    )
  `);

  await testClient.execute(`
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      user_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      connection_id TEXT,
      subscribed_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      notifications_enabled INTEGER DEFAULT 1,
      PRIMARY KEY (user_id, creator_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (creator_id) REFERENCES creators(creator_id) ON DELETE CASCADE
    )
  `);

  // Insert test user
  const now = new Date().toISOString();
  await db.insert(usersTable).values({
    userId: "test-user",
    email: "test@example.com",
    phoneNumber: null,
    displayName: "Test User",
    avatarUrl: null,
    createdAt: now,
    lastLoginAt: now,
  });

  // Insert test Gmail connection
  const gmailRepo = createGmailRepository(db);
  await gmailRepo.saveConnection(
    "test-user",
    {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      expiry_date: Date.now() + 3600000,
    },
    "test@gmail.com"
  );
}

// ============================================================================
// TESTS
// ============================================================================

describe("Gmail Ingestion Service", () => {
  beforeAll(async () => {
    await initTestDatabase();
  });

  it("should create service from connection", async () => {
    const service = await GmailIngestionService.fromConnection(
      db,
      "test-user",
      true // Use mock
    );

    expect(service).toBeDefined();
  });

  it("should ingest Substack posts from mock fixture", async () => {
    const service = await GmailIngestionService.fromConnection(
      db,
      "test-user",
      true // Use mock
    );

    const result = await service.ingestSubstackPosts();

    // Mock fixture has 2 messages
    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("should create creators for Substack authors", async () => {
    const creators = await db
      .select()
      .from(creatorsTable)
      .where(eq(creatorsTable.sourceType, "substack"));

    expect(creators.length).toBeGreaterThanOrEqual(2);

    const creatorNames = creators.map(c => c.name);
    expect(creatorNames).toContain("Jane Doe");
    expect(creatorNames).toContain("John Smith");
  });

  it("should create content items for Substack posts", async () => {
    const content = await db
      .select()
      .from(contentItemsTable)
      .where(eq(contentItemsTable.sourceType, "substack"));

    expect(content.length).toBeGreaterThanOrEqual(2);

    const titles = content.map(c => c.title);
    expect(titles).toContain("How to Build Better Software");
    expect(titles).toContain("The Future of AI");
  });

  it("should track processed messages", async () => {
    const processed = await db
      .select()
      .from(gmailProcessedMessagesTable);

    expect(processed.length).toBeGreaterThanOrEqual(2);

    const messageIds = processed.map(p => p.messageId);
    expect(messageIds).toContain("mock-msg-001");
    expect(messageIds).toContain("mock-msg-002");
  });

  it("should auto-subscribe user to Substack authors", async () => {
    const subscriptions = await db
      .select()
      .from(userSubscriptionsTable)
      .where(eq(userSubscriptionsTable.userId, "test-user"));

    expect(subscriptions.length).toBeGreaterThanOrEqual(2);
    expect(subscriptions.every(s => s.isActive)).toBe(true);
  });

  it("should deduplicate on re-run", async () => {
    const service = await GmailIngestionService.fromConnection(
      db,
      "test-user",
      true
    );

    // Run again - should skip all messages
    const result = await service.ingestSubstackPosts();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it("should generate content hashes correctly", async () => {
    const processed = await db
      .select()
      .from(gmailProcessedMessagesTable);

    // All messages should have unique content hashes
    const hashes = processed.map(p => p.contentHash);
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(hashes.length);
  });
});
