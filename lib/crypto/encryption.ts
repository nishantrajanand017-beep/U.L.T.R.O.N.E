import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

/**
 * Derives a consistent 256-bit encryption key.
 * Prioritizes ENCRYPTION_SECRET from env, with a deterministic fallback for dev environments.
 */
function getEncryptionKey(): Buffer {
  const secret =
    process.env.ENCRYPTION_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "ultron-default-secret-salt-2026-phase-9-secure-key";

  return crypto.createHash("sha256").update(secret).digest();
}

export interface EncryptedPayload {
  ciphertext: string; // hex
  iv: string; // hex
  tag: string; // hex
}

/**
 * Encrypts a plaintext string (such as an API key) using AES-256-GCM.
 * Plaintext is never logged or exposed.
 */
export function encryptApiKey(plaintext: string): EncryptedPayload {
  if (!plaintext || typeof plaintext !== "string") {
    throw new Error("Invalid plaintext provided for encryption");
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

/**
 * Decrypts an encrypted payload back into plaintext string.
 * Throws a sanitized error if authentication tag fails or decryption fails.
 */
export function decryptApiKey(payload: EncryptedPayload): string {
  if (!payload || !payload.ciphertext || !payload.iv || !payload.tag) {
    throw new Error("Invalid encrypted payload structure");
  }

  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(payload.iv, "hex");
    const tag = Buffer.from(payload.tag, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(payload.ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch {
    throw new Error("Failed to securely decrypt stored credential");
  }
}

/**
 * Formats a masked key hint for display in the UI (e.g. "••••••••••••oVyl").
 * Ensures full key is never revealed.
 */
export function maskApiKey(rawKey: string): string {
  if (!rawKey || typeof rawKey !== "string") return "";
  const trimmed = rawKey.trim();
  if (trimmed.length <= 4) return "••••";
  const suffix = trimmed.slice(-4);
  return `••••••••••••${suffix}`;
}
