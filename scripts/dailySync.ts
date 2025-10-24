import "dotenv/config";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { usersTable } from "../schema";
import { GmailIngestionService } from "../src/gmail";

// ============================================================================
// CONFIGURATION
// ============================================================================

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;

if (!tursoUrl || !tursoAuthToken) {
  console.error("❌ Missing Turso credentials");
  console.error("   Please set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN");
  process.exit(1);
}

// Check if Gmail feature is enabled
const gmailEnabled = process.env.FEATURE_GMAIL_INGEST === "on";
if (!gmailEnabled) {
  console.log("⚠️  Gmail ingestion feature is disabled (FEATURE_GMAIL_INGEST=off)");
  process.exit(0);
}

// ============================================================================
// MAIN SYNC FUNCTION
// ============================================================================

async function syncAllUsers() {
  console.log("🔄 Starting daily Gmail sync...");
  console.log(`📅 ${new Date().toISOString()}`);

  const client = createClient({
    url: tursoUrl,
    authToken: tursoAuthToken,
  });

  const db = drizzle(client);

  try {
    // Get all active users
    const users = await db.select().from(usersTable);
    console.log(`👥 Found ${users.length} users`);

    let totalProcessed = 0;
    let totalSkipped = 0;
    let successCount = 0;
    let errorCount = 0;

    for (const user of users) {
      console.log(`\n📧 Processing user: ${user.userId} (${user.email || "no email"})`);

      try {
        // Use mock data if MOCK_GMAIL=on
        const useMock = process.env.MOCK_GMAIL === "on";

        // Create service and ingest posts
        const service = await GmailIngestionService.fromConnection(
          db,
          user.userId,
          useMock
        );

        const result = await service.ingestSubstackPosts();
        totalProcessed += result.processed;
        totalSkipped += result.skipped;
        successCount++;

        console.log(`✅ User ${user.userId}: ${result.processed} new, ${result.skipped} skipped`);
      } catch (error) {
        if (error instanceof Error && error.message.includes("not connected Gmail")) {
          console.log(`⏭️  User ${user.userId} has not connected Gmail - skipping`);
        } else {
          console.error(`❌ Error processing user ${user.userId}:`, error);
          errorCount++;
        }
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("📊 Daily sync complete!");
    console.log(`   Users processed: ${successCount}`);
    console.log(`   Users with errors: ${errorCount}`);
    console.log(`   Total new posts: ${totalProcessed}`);
    console.log(`   Total skipped: ${totalSkipped}`);
    console.log("=".repeat(60));

    process.exit(0);
  } catch (error) {
    console.error("❌ Fatal error during sync:", error);
    process.exit(1);
  }
}

// ============================================================================
// RUN
// ============================================================================

syncAllUsers();
