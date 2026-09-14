/**
 * lib/memory/memoryStore.ts
 *
 * Server-side persistent user memory store for ULTRON.
 * Enforces:
 * 1. Strict tenant isolation (every query requires verified userId)
 * 2. Hard memory limits (max 200 items per user, 100-char key, 500-char value)
 * 3. Stable category enforcement (preference, profile, project, instruction)
 * 4. Upsert deduplication on (userId, category, key)
 * 5. Supabase primary database with local JSON file fallback for offline/test reliability
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { getSupabase } from "../db/deviceStore";

export type MemoryCategory = "preference" | "profile" | "project" | "instruction";

export const ALLOWED_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
  "preference",
  "profile",
  "project",
  "instruction",
]);

export interface UserMemory {
  id: string;
  userId: string;
  category: MemoryCategory;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

interface DbMemoryRow {
  id: string;
  user_id: string;
  category: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

interface MemoryStoreData {
  version: number;
  memories: Record<string, UserMemory>; // keyed by memory id
}

export const MAX_MEMORIES_PER_USER = 200;
export const MAX_KEY_LENGTH = 100;
export const MAX_VALUE_LENGTH = 500;
export const MAX_CATEGORY_LENGTH = 50;

let writeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn);
  writeLock = next.then(() => {}, () => {});
  return next;
}

function getDataDir(): string {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), "ultron_data");
  }
  return path.join(process.cwd(), "data");
}

function getMemoriesFilePath(): string {
  return path.join(getDataDir(), "user_memories.json");
}

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(getDataDir(), { recursive: true });
  } catch {
    // Directory may already exist
  }
}

async function loadLocalStore(): Promise<MemoryStoreData> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(getMemoriesFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as MemoryStoreData;
    if (parsed && typeof parsed.memories === "object") {
      return parsed;
    }
  } catch {
    // File doesn't exist yet or is empty
  }
  return { version: 1, memories: {} };
}

async function saveLocalStore(data: MemoryStoreData): Promise<void> {
  await ensureDataDir();
  const filePath = getMemoriesFilePath();
  const tmpFile = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const content = JSON.stringify(data, null, 2);

  try {
    await fs.writeFile(tmpFile, content, "utf-8");
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    // Fallback direct write on rename locking error
    await fs.writeFile(filePath, content, "utf-8").catch(() => {});
    await fs.unlink(tmpFile).catch(() => {});
  }
}

function mapRowToMemory(row: DbMemoryRow): UserMemory {
  return {
    id: row.id,
    userId: row.user_id,
    category: (ALLOWED_CATEGORIES.has(row.category as MemoryCategory)
      ? row.category
      : "preference") as MemoryCategory,
    key: row.key,
    value: row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMemoryToRow(memory: UserMemory): DbMemoryRow {
  return {
    id: memory.id,
    user_id: memory.userId,
    category: memory.category,
    key: memory.key,
    value: memory.value,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
  };
}

/**
 * Validates category against allowed stable categories.
 */
export function isValidCategory(cat: unknown): cat is MemoryCategory {
  return typeof cat === "string" && ALLOWED_CATEGORIES.has(cat as MemoryCategory);
}

/**
 * Validates memory key and value constraints.
 */
export function validateMemoryInput(
  category: unknown,
  key: unknown,
  value: unknown
): { category: MemoryCategory; key: string; value: string } {
  if (!isValidCategory(category)) {
    throw new Error(
      `Invalid category: '${String(category)}'. Allowed categories: preference, profile, project, instruction.`
    );
  }

  if (typeof key !== "string" || !key.trim()) {
    throw new Error("Invalid memory key: key must be a non-empty string.");
  }

  const trimmedKey = key.trim().toLowerCase().replace(/\s+/g, "_");
  if (trimmedKey.length > MAX_KEY_LENGTH) {
    throw new Error(`Memory key exceeds maximum allowed length of ${MAX_KEY_LENGTH} characters.`);
  }

  // Enforce safe characters (alphanumeric, underscore, hyphens, periods)
  if (!/^[a-z0-9_\-\.]+$/.test(trimmedKey)) {
    throw new Error("Memory key can only contain lowercase alphanumeric characters, underscores, hyphens, and periods.");
  }

  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid memory value: value must be a non-empty string.");
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length > MAX_VALUE_LENGTH) {
    throw new Error(`Memory value exceeds maximum allowed length of ${MAX_VALUE_LENGTH} characters.`);
  }

  return {
    category,
    key: trimmedKey,
    value: trimmedValue,
  };
}

/**
 * Retrieves all memories strictly belonging to the authenticated userId.
 */
export async function getUserMemories(userId: string): Promise<UserMemory[]> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Authentication required: userId must be provided.");
  }

  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("ultron_user_memories")
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });

      if (!error && Array.isArray(data)) {
        return (data as DbMemoryRow[]).map(mapRowToMemory);
      }
    } catch (err) {
      console.warn("[Memory Store] Supabase query error, falling back to local:", err);
    }
  }

  // Fallback to local file store
  const store = await loadLocalStore();
  return Object.values(store.memories)
    .filter((m) => m.userId === userId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/**
 * Retrieves relevant memories for a user query, bounded by a maximum count.
 */
export async function getRelevantMemories(
  userId: string,
  query?: string,
  limit = 20
): Promise<UserMemory[]> {
  const allMemories = await getUserMemories(userId);
  if (allMemories.length === 0) return [];

  const maxReturn = Math.max(1, Math.min(limit, 20));

  if (!query || !query.trim()) {
    return allMemories.slice(0, maxReturn);
  }

  // Fast token-based relevance ranking
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);

  if (tokens.length === 0) {
    return allMemories.slice(0, maxReturn);
  }

  const scored = allMemories.map((mem) => {
    let score = 0;
    const memText = `${mem.category} ${mem.key} ${mem.value}`.toLowerCase();

    for (const token of tokens) {
      if (mem.key.includes(token)) score += 3;
      else if (mem.value.toLowerCase().includes(token)) score += 2;
      else if (mem.category.includes(token)) score += 1;
    }

    return { mem, score };
  });

  // Sort by score desc, then recency desc
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.mem.updatedAt).getTime() - new Date(a.mem.updatedAt).getTime();
  });

  return scored.slice(0, maxReturn).map((s) => s.mem);
}

/**
 * Saves or updates a memory.
 * Performs safe upsert on (userId, category, key).
 */
export async function saveMemory(
  userId: string,
  category: unknown,
  key: unknown,
  value: unknown
): Promise<UserMemory> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Authentication required: userId must be provided.");
  }

  const validated = validateMemoryInput(category, key, value);
  const nowIso = new Date().toISOString();

  return withLock(async () => {
    const existingMemories = await getUserMemories(userId);
    const existing = existingMemories.find(
      (m) => m.category === validated.category && m.key === validated.key
    );

    // If new memory, enforce maximum limit of 200 items per user
    if (!existing && existingMemories.length >= MAX_MEMORIES_PER_USER) {
      throw new Error(`Memory capacity exceeded: Maximum ${MAX_MEMORIES_PER_USER} memories allowed per user.`);
    }

    const memoryId = existing ? existing.id : crypto.randomUUID();
    const memoryRecord: UserMemory = {
      id: memoryId,
      userId,
      category: validated.category,
      key: validated.key,
      value: validated.value,
      createdAt: existing ? existing.createdAt : nowIso,
      updatedAt: nowIso,
    };

    // Primary: Supabase
    const supabase = getSupabase();
    if (supabase) {
      try {
        await supabase
          .from("ultron_user_memories")
          .upsert(mapMemoryToRow(memoryRecord), { onConflict: "user_id,category,key" });
      } catch (err) {
        console.warn("[Memory Store] Supabase upsert error:", err);
      }
    }

    // Secondary / local fallback
    const store = await loadLocalStore();
    store.memories[memoryId] = memoryRecord;
    await saveLocalStore(store);

    return memoryRecord;
  });
}

/**
 * Updates an existing memory value by ID, strictly verifying ownership.
 */
export async function updateMemory(
  userId: string,
  memoryId: string,
  value: unknown
): Promise<UserMemory | null> {
  if (!userId || !memoryId) return null;

  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid memory value: value must be a non-empty string.");
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length > MAX_VALUE_LENGTH) {
    throw new Error(`Memory value exceeds maximum allowed length of ${MAX_VALUE_LENGTH} characters.`);
  }

  return withLock(async () => {
    const memories = await getUserMemories(userId);
    const target = memories.find((m) => m.id === memoryId);
    if (!target) return null; // Ownership check: not found or belongs to another user

    const nowIso = new Date().toISOString();
    const updated: UserMemory = {
      ...target,
      value: trimmedValue,
      updatedAt: nowIso,
    };

    const supabase = getSupabase();
    if (supabase) {
      try {
        await supabase
          .from("ultron_user_memories")
          .update({ value: trimmedValue, updated_at: nowIso })
          .eq("id", memoryId)
          .eq("user_id", userId);
      } catch (err) {
        console.warn("[Memory Store] Supabase update error:", err);
      }
    }

    const store = await loadLocalStore();
    if (store.memories[memoryId] && store.memories[memoryId].userId === userId) {
      store.memories[memoryId] = updated;
      await saveLocalStore(store);
    }

    return updated;
  });
}

/**
 * Deletes a specific memory by ID, strictly verifying ownership.
 */
export async function deleteMemory(userId: string, memoryId: string): Promise<boolean> {
  if (!userId || !memoryId) return false;

  return withLock(async () => {
    const memories = await getUserMemories(userId);
    const target = memories.find((m) => m.id === memoryId);
    if (!target) return false; // Not found or belongs to another user

    const supabase = getSupabase();
    if (supabase) {
      try {
        await supabase
          .from("ultron_user_memories")
          .delete()
          .eq("id", memoryId)
          .eq("user_id", userId);
      } catch (err) {
        console.warn("[Memory Store] Supabase delete error:", err);
      }
    }

    const store = await loadLocalStore();
    if (store.memories[memoryId] && store.memories[memoryId].userId === userId) {
      delete store.memories[memoryId];
      await saveLocalStore(store);
    }

    return true;
  });
}

/**
 * Clears all memories strictly for the specified userId.
 */
export async function clearUserMemories(userId: string): Promise<number> {
  if (!userId) return 0;

  return withLock(async () => {
    const userMems = await getUserMemories(userId);
    const count = userMems.length;
    if (count === 0) return 0;

    const supabase = getSupabase();
    if (supabase) {
      try {
        await supabase
          .from("ultron_user_memories")
          .delete()
          .eq("user_id", userId);
      } catch (err) {
        console.warn("[Memory Store] Supabase clear error:", err);
      }
    }

    const store = await loadLocalStore();
    for (const mem of userMems) {
      delete store.memories[mem.id];
    }
    await saveLocalStore(store);

    return count;
  });
}

/**
 * Test helper to reset memories (used in test suites)
 */
export async function _clearAllMemoriesForTesting(): Promise<void> {
  await withLock(async () => {
    const supabase = getSupabase();
    if (supabase) {
      try {
        await supabase.from("ultron_user_memories").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      } catch {
        // ignore
      }
    }
    await saveLocalStore({ version: 1, memories: {} });
  });
}
