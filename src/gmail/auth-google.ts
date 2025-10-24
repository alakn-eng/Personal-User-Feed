import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import { Router } from "express";
import { LibSQLDatabase } from "drizzle-orm/libsql";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { gmailConnectionsTable, usersTable } from "../../schema";
import { encrypt, decrypt } from "./crypto";

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;

// ============================================================================
// OAUTH HELPERS
// ============================================================================

function createGmailOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_GMAIL_REDIRECT_URI || `${process.env.GOOGLE_REDIRECT_URI?.replace('/youtube/', '/gmail/')}`;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing Google OAuth environment variables for Gmail");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function createGmailAuthUrl({ state }: { state?: string } = {}) {
  const client = createGmailOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: [...GMAIL_SCOPES],
    include_granted_scopes: true,
    prompt: "consent",
    state,
  });
}

export async function exchangeGmailCodeForTokens(code: string) {
  const client = createGmailOAuthClient();
  const { tokens } = await client.getToken(code);
  return { client, tokens };
}

export async function refreshGmailAccessToken(
  encryptedAccessToken: string,
  encryptedRefreshToken: string,
  tokenExpiresAt: number | null
) {
  const client = createGmailOAuthClient();

  const accessToken = decrypt(encryptedAccessToken);
  const refreshToken = decrypt(encryptedRefreshToken);

  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expiry_date: tokenExpiresAt ?? undefined,
  });

  const { credentials } = await client.refreshAccessToken();
  return { client, credentials };
}

// ============================================================================
// REPOSITORY (Database operations for Gmail connections)
// ============================================================================

export interface GmailRepository {
  saveConnection(
    userId: string,
    tokens: Credentials,
    gmailAddress: string
  ): Promise<string>;
  getConnection(userId: string): Promise<{
    gmailConnectionId: string;
    userId: string;
    gmailAddress: string;
    encryptedAccessToken: string;
    encryptedRefreshToken: string;
    tokenExpiresAt: number | null;
    connectedAt: string;
    lastSyncedAt: string | null;
    isActive: boolean;
  } | null>;
  updateConnectionTokens(
    gmailConnectionId: string,
    tokens: Credentials
  ): Promise<void>;
  updateConnectionSync(gmailConnectionId: string, syncedAt: string): Promise<void>;
}

export function createGmailRepository(db: LibSQLDatabase<Record<string, never>>): GmailRepository {
  return {
    async saveConnection(userId, tokens, gmailAddress) {
      const gmailConnectionId = nanoid();
      const now = new Date().toISOString();

      if (!tokens.access_token || !tokens.refresh_token) {
        throw new Error("Missing access or refresh token");
      }

      await db.insert(gmailConnectionsTable).values({
        gmailConnectionId,
        userId,
        gmailAddress,
        encryptedAccessToken: encrypt(tokens.access_token),
        encryptedRefreshToken: encrypt(tokens.refresh_token),
        tokenExpiresAt: tokens.expiry_date ?? null,
        connectedAt: now,
        lastSyncedAt: null,
        isActive: true,
      });

      return gmailConnectionId;
    },

    async getConnection(userId) {
      const rows = await db
        .select()
        .from(gmailConnectionsTable)
        .where(
          and(
            eq(gmailConnectionsTable.userId, userId),
            eq(gmailConnectionsTable.isActive, true)
          )
        )
        .limit(1);

      return rows[0] ?? null;
    },

    async updateConnectionTokens(gmailConnectionId, tokens) {
      const updates: {
        encryptedAccessToken?: string;
        encryptedRefreshToken?: string;
        tokenExpiresAt?: number | null;
      } = {};

      if (tokens.access_token) {
        updates.encryptedAccessToken = encrypt(tokens.access_token);
      }
      if (tokens.refresh_token) {
        updates.encryptedRefreshToken = encrypt(tokens.refresh_token);
      }
      updates.tokenExpiresAt = tokens.expiry_date ?? null;

      await db
        .update(gmailConnectionsTable)
        .set(updates)
        .where(eq(gmailConnectionsTable.gmailConnectionId, gmailConnectionId));
    },

    async updateConnectionSync(gmailConnectionId, syncedAt) {
      await db
        .update(gmailConnectionsTable)
        .set({ lastSyncedAt: syncedAt })
        .where(eq(gmailConnectionsTable.gmailConnectionId, gmailConnectionId));
    },
  };
}

// ============================================================================
// EXPRESS ROUTER (OAuth routes for Gmail)
// ============================================================================

export function createGmailAuthRouter(db: LibSQLDatabase<Record<string, never>>) {
  const router = Router();
  const gmailRepo = createGmailRepository(db);

  // Initiate Gmail OAuth flow
  router.get("/auth", (req, res) => {
    try {
      const authUrl = createGmailAuthUrl({ state: "gmail-auth-state" });
      res.redirect(authUrl);
    } catch (error) {
      console.error("Gmail auth URL generation failed:", error);
      res.status(500).send("Failed to initiate Gmail authentication");
    }
  });

  // Gmail OAuth callback
  router.get("/callback", async (req, res) => {
    const { code } = req.query;

    if (!code || typeof code !== "string") {
      return res.status(400).send("Missing authorization code");
    }

    try {
      const { client: oauthClient, tokens } = await exchangeGmailCodeForTokens(code);
      oauthClient.setCredentials(tokens);

      // Get user's Gmail address
      const gmail = google.gmail({ version: "v1", auth: oauthClient });
      const profile = await gmail.users.getProfile({ userId: "me" });
      const gmailAddress = profile.data.emailAddress || "unknown@gmail.com";

      // Get userId from session (using same temp-user approach as YouTube)
      const userId = req.session.userId || "temp-user";
      req.session.userId = userId;

      // Ensure user exists in database
      const existingUser = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.userId, userId))
        .limit(1);

      if (existingUser.length === 0) {
        const now = new Date().toISOString();
        await db.insert(usersTable).values({
          userId,
          email: gmailAddress,
          phoneNumber: null,
          displayName: "Temp User",
          avatarUrl: null,
          createdAt: now,
          lastLoginAt: now,
        });
      }

      // Save Gmail connection
      const connectionId = await gmailRepo.saveConnection(userId, tokens, gmailAddress);

      console.log(`✅ Gmail connected for user: ${userId} (${gmailAddress})`);

      // Sync Substack posts immediately (just like YouTube syncs on connect)
      console.log(`🔄 Syncing Substack posts from Gmail...`);
      const { GmailIngestionService } = await import("./gmail-ingest");
      const ingestionService = new GmailIngestionService(
        db,
        gmailRepo,
        userId,
        connectionId,
        false // Use real Gmail, not mock
      );

      const result = await ingestionService.ingestSubstackPosts();
      console.log(`✅ Gmail sync complete: ${result.processed} new, ${result.skipped} skipped`);

      // Redirect back to main page
      res.redirect("/");
    } catch (error) {
      console.error("Gmail auth error:", error);
      res.status(500).send("Gmail authentication failed. Please try again.");
    }
  });

  return router;
}
