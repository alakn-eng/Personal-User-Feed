import crypto from "crypto";

// Use AES-256-GCM for encryption
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Gets the encryption key from environment variable.
 * In production, this should be a strong randomly generated key.
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;

  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }

  // Key must be 32 bytes for AES-256
  if (key.length !== 64) { // 64 hex characters = 32 bytes
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }

  return Buffer.from(key, "hex");
}

/**
 * Encrypts a plaintext string using AES-256-GCM
 * Returns: base64-encoded string in format: iv:authTag:ciphertext
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Combine iv + authTag + ciphertext
  const combined = `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext}`;

  return Buffer.from(combined).toString("base64");
}

/**
 * Decrypts a ciphertext string encrypted with encrypt()
 * Expects: base64-encoded string in format: iv:authTag:ciphertext
 */
export function decrypt(encryptedData: string): string {
  const key = getEncryptionKey();

  // Decode from base64
  const combined = Buffer.from(encryptedData, "base64").toString("utf8");
  const parts = combined.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const ciphertext = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(ciphertext, "hex", "utf8");
  plaintext += decipher.final("utf8");

  return plaintext;
}
