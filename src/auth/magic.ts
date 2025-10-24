import { Magic } from "@magic-sdk/admin";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { usersTable } from "../../schema";

/**
 * Magic.link Authentication Service
 *
 * This module handles passwordless authentication using Magic.link.
 * It validates DID tokens and manages user sessions.
 */

export class MagicAuthService {
  private magic: Magic;
  private db: LibSQLDatabase<Record<string, never>>;

  constructor(secretKey: string, db: LibSQLDatabase<Record<string, never>>) {
    this.magic = new Magic(secretKey);
    this.db = db;
  }

  /**
   * Validate a DID token from Magic.link
   * Returns the user's metadata if valid, throws error if invalid
   */
  async validateToken(didToken: string) {
    try {
      // Validate the DID token with Magic
      this.magic.token.validate(didToken);

      // Get user metadata from the token
      const metadata = await this.magic.users.getMetadataByToken(didToken);

      if (!metadata.issuer || !metadata.publicAddress) {
        throw new Error("Invalid user metadata from Magic.link");
      }

      return {
        issuer: metadata.issuer, // Unique user ID from Magic
        email: metadata.email,
        publicAddress: metadata.publicAddress,
      };
    } catch (error) {
      console.error("[Magic] Token validation failed:", error);
      throw new Error("Invalid authentication token");
    }
  }

  /**
   * Get or create user from Magic.link metadata
   * This ensures a user record exists in our database
   */
  async getOrCreateUser(metadata: { issuer: string; email: string | null; publicAddress: string }) {
    const userId = `magic-${metadata.issuer}`;

    // Check if user exists
    const existing = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      // Update last login
      const now = new Date().toISOString();
      await this.db
        .update(usersTable)
        .set({ lastLoginAt: now })
        .where(eq(usersTable.userId, userId));

      return existing[0];
    }

    // Create new user
    const now = new Date().toISOString();
    await this.db.insert(usersTable).values({
      userId,
      email: metadata.email,
      phoneNumber: null,
      displayName: metadata.email?.split("@")[0] || "User",
      avatarUrl: null,
      createdAt: now,
      lastLoginAt: now,
    });

    console.log(`✅ Created new Magic.link user: ${userId} (${metadata.email})`);

    // Return the newly created user
    const newUser = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.userId, userId))
      .limit(1);

    return newUser[0];
  }

  /**
   * Logout user by invalidating their Magic session
   */
  async logout(didToken: string) {
    try {
      await this.magic.users.logoutByToken(didToken);
      return true;
    } catch (error) {
      console.error("[Magic] Logout failed:", error);
      return false;
    }
  }
}

/**
 * Create a Magic.link auth service instance
 */
export function createMagicAuthService(
  db: LibSQLDatabase<Record<string, never>>
): MagicAuthService | null {
  const secretKey = process.env.MAGIC_SECRET_KEY;

  if (!secretKey) {
    console.warn("⚠️  Magic.link disabled - MAGIC_SECRET_KEY not configured");
    return null;
  }

  return new MagicAuthService(secretKey, db);
}
