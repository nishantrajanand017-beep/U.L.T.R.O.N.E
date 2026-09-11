import fs from "node:fs/promises";
import path from "node:path";
import {
  encryptApiKey,
  decryptApiKey,
  maskApiKey,
  type EncryptedPayload,
} from "../crypto/encryption";

export type KeyStatus =
  | "not_configured"
  | "configured"
  | "valid"
  | "invalid"
  | "error";

export interface StoredUserKey {
  userId: string;
  provider: "gemini";
  encrypted: EncryptedPayload;
  keyHint: string;
  status: KeyStatus;
  lastTestedAt: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserApiKeyPublicInfo {
  provider: "gemini";
  isConfigured: boolean;
  status: KeyStatus;
  keyHint: string | null;
  lastTestedAt: string | null;
  updatedAt: string | null;
  errorMessage?: string | null;
}

interface StoreData {
  version: number;
  users: Record<string, StoredUserKey>;
}

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "user_api_keys.json");

// In-memory mutex / lock to prevent race conditions during file read-modify-write
let writeLock: Promise<void> = Promise.resolve();

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

async function loadStore(): Promise<StoreData> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as StoreData;
    if (parsed && typeof parsed.users === "object") {
      return parsed;
    }
  } catch {
    // File doesn't exist or is empty/corrupt
  }
  return { version: 1, users: {} };
}

async function saveStore(data: StoreData): Promise<void> {
  await ensureDataDir();
  const tmpFile = `${STORE_FILE}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpFile, content, "utf-8");

  let renamed = false;
  for (let i = 0; i < 5; i++) {
    try {
      await fs.rename(tmpFile, STORE_FILE);
      renamed = true;
      break;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        await new Promise((resolve) => setTimeout(resolve, 30 * (i + 1)));
      } else {
        throw err;
      }
    }
  }

  if (!renamed) {
    await fs.writeFile(STORE_FILE, content, "utf-8");
    try {
      await fs.unlink(tmpFile);
    } catch {
      // ignore
    }
  }
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn);
  writeLock = next.then(() => {}, () => {});
  return next;
}

/**
 * Retrieves public (sanitized/masked) info about a user's API key.
 * Never leaks the actual key or decrypted payload.
 */
export async function getUserApiKeyPublicInfo(
  userId: string
): Promise<UserApiKeyPublicInfo> {
  if (!userId) {
    return {
      provider: "gemini",
      isConfigured: false,
      status: "not_configured",
      keyHint: null,
      lastTestedAt: null,
      updatedAt: null,
    };
  }

  const store = await loadStore();
  const record = store.users[userId];

  if (!record) {
    return {
      provider: "gemini",
      isConfigured: false,
      status: "not_configured",
      keyHint: null,
      lastTestedAt: null,
      updatedAt: null,
    };
  }

  return {
    provider: record.provider,
    isConfigured: true,
    status: record.status,
    keyHint: record.keyHint,
    lastTestedAt: record.lastTestedAt,
    updatedAt: record.updatedAt,
    errorMessage: record.errorMessage || null,
  };
}

/**
 * Saves and encrypts an API key for the specified user.
 * Plaintext key is encrypted immediately and discarded from memory.
 */
export async function saveUserApiKey(
  userId: string,
  rawKey: string,
  provider: "gemini" = "gemini"
): Promise<UserApiKeyPublicInfo> {
  if (!userId) throw new Error("User ID is required");
  const trimmedKey = rawKey?.trim();
  if (!trimmedKey) throw new Error("API key cannot be empty");

  const encrypted = encryptApiKey(trimmedKey);
  const keyHint = maskApiKey(trimmedKey);
  const now = new Date().toISOString();

  return withLock(async () => {
    const store = await loadStore();
    const existing = store.users[userId];

    const updatedRecord: StoredUserKey = {
      userId,
      provider,
      encrypted,
      keyHint,
      status: "configured",
      lastTestedAt: null,
      errorMessage: null,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    store.users[userId] = updatedRecord;
    await saveStore(store);

    return {
      provider: updatedRecord.provider,
      isConfigured: true,
      status: updatedRecord.status,
      keyHint: updatedRecord.keyHint,
      lastTestedAt: updatedRecord.lastTestedAt,
      updatedAt: updatedRecord.updatedAt,
    };
  });
}

/**
 * Retrieves and decrypts the user's API key on the backend.
 * ONLY called server-side when dispatching an AI request.
 */
export async function getUserDecryptedApiKey(
  userId: string
): Promise<string | null> {
  if (!userId) return null;

  const store = await loadStore();
  const record = store.users[userId];
  if (!record || !record.encrypted) return null;

  try {
    return decryptApiKey(record.encrypted);
  } catch (err) {
    console.error(`[Security] Failed to decrypt API key for user ${userId}:`, err);
    return null;
  }
}

/**
 * Updates the validation status of a user's API key.
 */
export async function updateUserKeyStatus(
  userId: string,
  status: KeyStatus,
  errorMessage?: string | null
): Promise<void> {
  if (!userId) return;

  await withLock(async () => {
    const store = await loadStore();
    const record = store.users[userId];
    if (!record) return;

    record.status = status;
    record.lastTestedAt = new Date().toISOString();
    record.errorMessage = errorMessage || null;
    record.updatedAt = new Date().toISOString();

    store.users[userId] = record;
    await saveStore(store);
  });
}

/**
 * Removes the stored key for a given user.
 */
export async function deleteUserApiKey(userId: string): Promise<boolean> {
  if (!userId) return false;

  return withLock(async () => {
    const store = await loadStore();
    if (!store.users[userId]) {
      return false;
    }

    delete store.users[userId];
    await saveStore(store);
    return true;
  });
}
