import "dotenv/config";
import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { google } from "googleapis";
import { eq } from "drizzle-orm";
import {
  createYouTubeRepository,
  createAuthUrl,
  exchangeCodeForTokens,
  YouTubeIngestionService,
} from "./youtube.js";
import { usersTable } from "./schema.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// CONFIGURATION CHECKS
// ============================================================================

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI;

// Check Turso credentials (REQUIRED for server to start)
if (!tursoUrl || !tursoAuthToken) {
  console.error("❌ Missing Turso credentials!");
  console.error("   Please set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your .env file");
  console.error("   See .env.example for setup instructions");
  process.exit(1);
}

// Check YouTube OAuth (OPTIONAL - feature will be disabled if missing)
const youtubeEnabled = !!(googleClientId && googleClientSecret && googleRedirectUri);
if (!youtubeEnabled) {
  console.warn("⚠️  YouTube integration disabled - missing Google OAuth credentials");
  console.warn("   Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to enable");
}

// ============================================================================
// DATABASE SETUP
// ============================================================================

const client = createClient({
  url: tursoUrl,
  authToken: tursoAuthToken,
});

const db = drizzle(client);
const youtubeRepo = createYouTubeRepository(db);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function ensureUserExists(userId: string) {
  // Check if user exists
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.userId, userId))
    .limit(1);

  if (existing.length === 0) {
    // Create user if doesn't exist
    const now = new Date().toISOString();
    await db.insert(usersTable).values({
      userId,
      email: null,
      phoneNumber: null,
      displayName: "Temp User",
      avatarUrl: null,
      createdAt: now,
      lastLoginAt: now,
    });
    console.log(`✅ Created user: ${userId}`);
  }
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);

// Extend session type
declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

// Serve static files (HTML, CSS, JS)
app.use(express.static("."));

// ============================================================================
// HEALTH & CONFIG ENDPOINTS
// ============================================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    database: "connected",
    features: {
      youtube: youtubeEnabled,
      magicLink: false, // Not implemented yet
    },
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    features: {
      youtube: youtubeEnabled,
      substack: false,
      twitter: false,
      rss: false,
    },
    version: "1.0.0",
  });
});

// ============================================================================
// YOUTUBE ROUTES (with graceful error handling)
// ============================================================================

app.get("/auth/youtube", (req, res) => {
  if (!youtubeEnabled) {
    return res.status(503).send(
      "YouTube integration is not configured. Please contact the administrator."
    );
  }

  try {
    const authUrl = createAuthUrl({ state: "random-state-string" });
    res.redirect(authUrl);
  } catch (error) {
    console.error("YouTube auth URL generation failed:", error);
    res.status(500).send("Failed to initiate YouTube authentication");
  }
});

app.get("/auth/youtube/callback", async (req, res) => {
  if (!youtubeEnabled) {
    return res.status(503).send("YouTube integration is not configured");
  }

  const { code, state } = req.query;

  if (!code || typeof code !== "string") {
    return res.status(400).send("Missing authorization code");
  }

  try {
    // Exchange the authorization code for tokens
    const { client: oauthClient, tokens } = await exchangeCodeForTokens(code);

    // Set credentials on the OAuth client
    oauthClient.setCredentials(tokens);

    // TODO: Replace with real user auth - for now use temp user ID
    const userId = req.session.userId || "temp-user";
    req.session.userId = userId;

    // Ensure user exists in database first
    await ensureUserExists(userId);

    // Save YouTube connection
    const connectionId = await youtubeRepo.saveConnection(userId, tokens);

    // Create YouTube service and sync
    const youtube = google.youtube({ version: "v3", auth: oauthClient });
    const service = new YouTubeIngestionService(youtubeRepo, youtube, userId, connectionId);

    console.log(`🔄 Syncing YouTube subscriptions for user: ${userId}`);
    await service.syncUserSubscriptions();

    console.log(`📹 Fetching latest videos...`);
    await service.syncUploads(20);

    console.log(`✅ YouTube sync complete`);

    // Redirect back to the main page
    res.redirect("/");
  } catch (error) {
    console.error("YouTube auth error:", error);
    res.status(500).send(
      "Authentication failed. Please try again or contact support if the problem persists."
    );
  }
});

app.get("/api/youtube/videos", async (req, res) => {
  if (!youtubeEnabled) {
    return res.status(503).json({
      error: "YouTube integration is not configured",
      videos: [],
    });
  }

  try {
    const userId = req.session.userId || "temp-user";
    const limit = parseInt(req.query.limit as string) || 5;

    // Get stored connection and create service
    const service = await YouTubeIngestionService.fromConnection(youtubeRepo, userId);
    const videos = await service.latestVideos(limit);

    res.json({ videos });
  } catch (error) {
    console.error("Failed to fetch videos:", error);

    // Check if user hasn't connected YouTube yet
    if (error instanceof Error && error.message.includes("not connected")) {
      return res.status(404).json({
        error: "YouTube not connected",
        message: "Please connect your YouTube account first",
        videos: [],
      });
    }

    res.status(500).json({
      error: "Failed to fetch videos",
      videos: [],
    });
  }
});

app.post("/api/youtube/pins/:videoId", async (req, res) => {
  if (!youtubeEnabled) {
    return res.status(503).json({
      error: "YouTube integration is not configured",
    });
  }

  try {
    const userId = req.session.userId || "temp-user";
    const { videoId } = req.params;

    // TODO: Implement pin/unpin logic
    // Need to add pin management methods to repository
    res.json({ success: true, videoId });
  } catch (error) {
    console.error("Failed to toggle pin:", error);
    res.status(500).json({ error: "Failed to toggle pin" });
  }
});

// ============================================================================
// 404 HANDLER
// ============================================================================

app.use((req, res) => {
  // Don't send 404 for static file routes
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: "Endpoint not found" });
  } else {
    res.status(404).send("Page not found");
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log("✨ Curator's Desk is running!");
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`🔍 Health: http://localhost:${PORT}/health`);
  console.log(`⚙️  Config: http://localhost:${PORT}/api/config`);

  if (youtubeEnabled) {
    console.log(`📺 YouTube: http://localhost:${PORT}/auth/youtube`);
  } else {
    console.log(`📺 YouTube: ❌ Disabled (missing credentials)`);
  }

  console.log("\n💡 Tip: Visit /health to check which features are enabled");
});
