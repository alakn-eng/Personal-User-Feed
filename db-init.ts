import "dotenv/config";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;

if (!tursoUrl || !tursoAuthToken) {
  throw new Error(
    "Missing Turso credentials. Please set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your .env file"
  );
}

const client = createClient({
  url: tursoUrl,
  authToken: tursoAuthToken,
});

const db = drizzle(client);

console.log("🚀 Starting database migration...");
console.log(`📍 Database: ${tursoUrl.replace(/\/\/.*@/, "//***@")}`);

async function migrate() {
  try {
    // Users table
    await client.execute(`
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
    console.log("✅ Created users table");

    // Connected sources table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS connected_sources (
        connection_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_account_id TEXT,
        source_account_name TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at INTEGER,
        metadata TEXT,
        connected_at TEXT NOT NULL,
        last_synced_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      )
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS connected_sources_user_idx ON connected_sources(user_id)
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS connected_sources_type_idx ON connected_sources(source_type)
    `);
    console.log("✅ Created connected_sources table");

    // Creators table
    await client.execute(`
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
    await client.execute(`
      CREATE INDEX IF NOT EXISTS creators_external_idx ON creators(source_type, external_id)
    `);
    console.log("✅ Created creators table");

    // User subscriptions table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS user_subscriptions (
        user_id TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        connection_id TEXT,
        subscribed_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        notifications_enabled INTEGER DEFAULT 1,
        PRIMARY KEY (user_id, creator_id),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (creator_id) REFERENCES creators(creator_id) ON DELETE CASCADE,
        FOREIGN KEY (connection_id) REFERENCES connected_sources(connection_id) ON DELETE SET NULL
      )
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS user_subscriptions_user_idx ON user_subscriptions(user_id)
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS user_subscriptions_creator_idx ON user_subscriptions(creator_id)
    `);
    console.log("✅ Created user_subscriptions table");

    // Content items table
    await client.execute(`
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
    await client.execute(`
      CREATE INDEX IF NOT EXISTS content_creator_idx ON content_items(creator_id)
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS content_published_idx ON content_items(published_at)
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS content_source_type_idx ON content_items(source_type)
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS content_external_idx ON content_items(source_type, external_id)
    `);
    console.log("✅ Created content_items table");

    // User read status table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS user_read_status (
        user_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        progress_percent INTEGER,
        PRIMARY KEY (user_id, content_id),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (content_id) REFERENCES content_items(content_id) ON DELETE CASCADE
      )
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS read_status_user_idx ON user_read_status(user_id)
    `);
    console.log("✅ Created user_read_status table");

    // User pins table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS user_pins (
        user_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        note TEXT,
        pinned_at TEXT NOT NULL,
        PRIMARY KEY (user_id, content_id),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (content_id) REFERENCES content_items(content_id) ON DELETE CASCADE
      )
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS pins_user_idx ON user_pins(user_id)
    `);
    console.log("✅ Created user_pins table");

    // User saves table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS user_saves (
        user_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        collection_name TEXT,
        PRIMARY KEY (user_id, content_id),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (content_id) REFERENCES content_items(content_id) ON DELETE CASCADE
      )
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS saves_user_idx ON user_saves(user_id)
    `);
    console.log("✅ Created user_saves table");

    // User preferences table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY,
        default_sort_order TEXT DEFAULT 'newest',
        default_filter_type TEXT DEFAULT 'all',
        items_per_page INTEGER DEFAULT 20,
        auto_mark_as_read INTEGER DEFAULT 0,
        sync_frequency_minutes INTEGER DEFAULT 360,
        email_digest_enabled INTEGER DEFAULT 0,
        email_digest_frequency TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      )
    `);
    console.log("✅ Created user_preferences table");

    // Sync jobs table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS sync_jobs (
        job_id TEXT PRIMARY KEY,
        user_id TEXT,
        connection_id TEXT,
        source_type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        items_processed INTEGER DEFAULT 0,
        error_message TEXT,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (connection_id) REFERENCES connected_sources(connection_id) ON DELETE CASCADE
      )
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS sync_jobs_status_idx ON sync_jobs(status)
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS sync_jobs_user_idx ON sync_jobs(user_id)
    `);
    console.log("✅ Created sync_jobs table");

    console.log("\n🎉 Migration completed successfully!");
    console.log("📊 Total tables created: 10");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    throw error;
  }
}

migrate()
  .then(() => {
    console.log("\n✨ Database is ready!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n💥 Fatal error:", error);
    process.exit(1);
  });
