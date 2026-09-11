import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface StoredDevice {
  deviceId: string;
  userId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  deviceTokenHash: string;
  connectionStatus: "connected" | "offline";
  createdAt: string;
  lastSeenAt: string;
  pairedAt: string;
}

export interface SanitizedDevice {
  deviceId: string;
  userId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  connectionStatus: "connected" | "offline";
  createdAt: string;
  lastSeenAt: string;
  pairedAt: string;
}

export interface PairingSession {
  code: string;
  userId: string;
  expiresAt: number;
  used: boolean;
}

interface DeviceStoreData {
  version: number;
  devices: Record<string, StoredDevice>; // keyed by deviceId
}

interface DbDeviceRow {
  device_id: string;
  user_id: string;
  device_name: string;
  platform: string;
  app_version: string;
  device_token_hash: string;
  connection_status: string;
  created_at: string;
  last_seen_at: string;
  paired_at: string;
}

interface DbPairingSessionRow {
  code: string;
  user_id: string;
  expires_at: number;
  used: boolean;
  created_at?: string;
}

// In-memory cache for fast local access and fallback
const activePairingSessions = new Map<string, PairingSession>();
let writeLock: Promise<void> = Promise.resolve();

export const HEARTBEAT_OFFLINE_THRESHOLD_MS = 90_000;
export const PAIRING_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token.trim()).digest("hex");
}

function sanitizeDevice(device: StoredDevice): SanitizedDevice {
  const isStale =
    device.connectionStatus === "connected" &&
    Date.now() - new Date(device.lastSeenAt).getTime() > HEARTBEAT_OFFLINE_THRESHOLD_MS;

  return {
    deviceId: device.deviceId,
    userId: device.userId,
    deviceName: device.deviceName,
    platform: device.platform,
    appVersion: device.appVersion,
    connectionStatus: isStale ? "offline" : device.connectionStatus,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    pairedAt: device.pairedAt,
  };
}

function mapRowToDevice(row: DbDeviceRow): StoredDevice {
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    deviceName: row.device_name,
    platform: row.platform,
    appVersion: row.app_version,
    deviceTokenHash: row.device_token_hash,
    connectionStatus: row.connection_status === "connected" ? "connected" : "offline",
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    pairedAt: row.paired_at,
  };
}

function mapDeviceToRow(device: StoredDevice): DbDeviceRow {
  return {
    device_id: device.deviceId,
    user_id: device.userId,
    device_name: device.deviceName,
    platform: device.platform,
    app_version: device.appVersion,
    device_token_hash: device.deviceTokenHash,
    connection_status: device.connectionStatus,
    created_at: device.createdAt,
    last_seen_at: device.lastSeenAt,
    paired_at: device.pairedAt,
  };
}

/**
 * Initializes or returns the Supabase client for device storage.
 */
let cachedSupabaseClient: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (cachedSupabaseClient) return cachedSupabaseClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();

  if (!url || !key || url.includes("your_supabase")) {
    return null;
  }

  try {
    cachedSupabaseClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    return cachedSupabaseClient;
  } catch (err) {
    console.error("[ULTRON DB] Failed to initialize Supabase client:", err);
    return null;
  }
}

/**
 * Safe local data directory.
 * On Vercel / AWS Lambda, process.cwd() is read-only /var/task, so we use os.tmpdir().
 */
function getDataDir(): string {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), "ultron_data");
  }
  return path.join(process.cwd(), "data");
}

function getDevicesFilePath(): string {
  return path.join(getDataDir(), "user_devices.json");
}

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(getDataDir(), { recursive: true });
  } catch {
    // Directory may already exist
  }
}

async function loadLocalStore(): Promise<DeviceStoreData> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(getDevicesFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as DeviceStoreData;
    if (parsed && typeof parsed.devices === "object") {
      return parsed;
    }
  } catch {
    // File does not exist yet or is empty
  }
  return { version: 1, devices: {} };
}

async function saveLocalStore(data: DeviceStoreData): Promise<void> {
  await ensureDataDir();
  const devicesFile = getDevicesFilePath();
  const tmpFile = `${devicesFile}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const content = JSON.stringify(data, null, 2);

  try {
    await fs.writeFile(tmpFile, content, "utf-8");
    let renamed = false;
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rename(tmpFile, devicesFile);
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
      await fs.writeFile(devicesFile, content, "utf-8");
      try {
        await fs.unlink(tmpFile);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    console.warn("[ULTRON DB] Warning: could not write local fallback store:", err);
  }
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn);
  writeLock = next.then(() => {}, () => {});
  return next;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [code, session] of activePairingSessions.entries()) {
    if (now > session.expiresAt || session.used) {
      activePairingSessions.delete(code);
    }
  }
}

/**
 * Creates a cryptographically random, short-lived (5-min) single-use pairing code for a user.
 * Persists session to Supabase database (or local memory/fallback).
 */
export async function createPairingSession(userId: string): Promise<{
  code: string;
  expiresAt: number;
  expiresInSeconds: number;
}> {
  pruneExpiredSessions();

  // Generate clean, human-readable 6-character uppercase alphanumeric code e.g. "7AF49C"
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const expiresAt = Date.now() + PAIRING_SESSION_TTL_MS;

  const sessionObj: PairingSession = {
    code,
    userId,
    expiresAt,
    used: false,
  };

  // Always keep in local memory for ultra-fast same-instance lookup
  activePairingSessions.set(code, sessionObj);

  // Persist to Supabase if configured
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from("ultron_pairing_sessions").insert({
        code,
        user_id: userId,
        expires_at: expiresAt,
        used: false,
      });
      if (error && error.code !== "PGRST205") {
        console.warn("[ULTRON DB] Failed to persist pairing session to Supabase:", error.message);
      }
    } catch (err) {
      console.warn("[ULTRON DB] Supabase pairing session insert exception:", err);
    }
  }

  return {
    code,
    expiresAt,
    expiresInSeconds: Math.floor(PAIRING_SESSION_TTL_MS / 1000),
  };
}

/**
 * Claims a pairing session with the provided code and registers the Android device.
 */
export async function claimPairingSession(
  code: string,
  deviceName: string,
  platform = "Android",
  appVersion = "1.0.0"
): Promise<{ device: SanitizedDevice; deviceAuthToken: string }> {
  pruneExpiredSessions();
  const normalizedCode = code.trim().toUpperCase();

  let session: PairingSession | null = activePairingSessions.get(normalizedCode) || null;

  // If not in local memory or expired, check Supabase
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("ultron_pairing_sessions")
        .select("*")
        .eq("code", normalizedCode)
        .maybeSingle();

      if (!error && data) {
        const row = data as DbPairingSessionRow;
        session = {
          code: row.code,
          userId: row.user_id,
          expiresAt: Number(row.expires_at),
          used: Boolean(row.used),
        };
      }
    } catch (err) {
      console.warn("[ULTRON DB] Supabase pairing query error:", err);
    }
  }

  if (!session) {
    throw new Error("Invalid or unknown pairing code.");
  }

  if (Date.now() > session.expiresAt) {
    activePairingSessions.delete(normalizedCode);
    if (supabase) {
      try {
        await supabase.from("ultron_pairing_sessions").delete().eq("code", normalizedCode);
      } catch {
        // ignore
      }
    }
    throw new Error("Pairing code has expired. Please generate a new code.");
  }

  if (session.used) {
    activePairingSessions.delete(normalizedCode);
    throw new Error("Pairing code has already been used.");
  }

  // Atomically mark session used in memory and Supabase
  session.used = true;
  activePairingSessions.delete(normalizedCode);

  if (supabase) {
    try {
      await supabase
        .from("ultron_pairing_sessions")
        .update({ used: true })
        .eq("code", normalizedCode);
      // Or delete the used session to keep table lean
      await supabase.from("ultron_pairing_sessions").delete().eq("code", normalizedCode);
    } catch {
      // ignore
    }
  }

  // Generate unique device ID and a 256-bit secure device auth token
  const deviceId = `dev_${crypto.randomBytes(12).toString("hex")}`;
  const rawDeviceAuthToken = `ultron_dev_${crypto.randomBytes(32).toString("hex")}`;
  const deviceTokenHash = hashToken(rawDeviceAuthToken);

  const nowIso = new Date().toISOString();
  const newDevice: StoredDevice = {
    deviceId,
    userId: session.userId,
    deviceName: deviceName.trim() || "Android Device",
    platform: platform.trim() || "Android",
    appVersion: appVersion.trim() || "1.0.0",
    deviceTokenHash,
    connectionStatus: "connected",
    createdAt: nowIso,
    lastSeenAt: nowIso,
    pairedAt: nowIso,
  };

  // Persist device to Supabase (primary) and local store (fallback/cache)
  if (supabase) {
    try {
      const { error } = await supabase.from("ultron_devices").insert(mapDeviceToRow(newDevice));
      if (error && error.code !== "PGRST205") {
        console.warn("[ULTRON DB] Failed to insert device into Supabase:", error.message);
      }
    } catch (err) {
      console.warn("[ULTRON DB] Supabase device insert error:", err);
    }
  }

  // Always save to local fallback
  await withLock(async () => {
    const store = await loadLocalStore();
    store.devices[deviceId] = newDevice;
    await saveLocalStore(store);
  });

  return {
    device: sanitizeDevice(newDevice),
    deviceAuthToken: rawDeviceAuthToken,
  };
}

/**
 * Lists all devices belonging strictly to the authenticated user.
 */
export async function listUserDevices(userId: string): Promise<SanitizedDevice[]> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("ultron_devices")
        .select("*")
        .eq("user_id", userId);

      if (!error && Array.isArray(data)) {
        return (data as DbDeviceRow[]).map((row) => sanitizeDevice(mapRowToDevice(row)));
      }
    } catch (err) {
      console.warn("[ULTRON DB] Supabase listUserDevices error, falling back to local:", err);
    }
  }

  // Fallback to local store
  const store = await loadLocalStore();
  const userDevices: SanitizedDevice[] = [];
  let needsSave = false;

  for (const device of Object.values(store.devices)) {
    if (device.userId === userId) {
      const sanitized = sanitizeDevice(device);
      if (sanitized.connectionStatus !== device.connectionStatus) {
        device.connectionStatus = sanitized.connectionStatus;
        needsSave = true;
      }
      userDevices.push(sanitized);
    }
  }

  if (needsSave) {
    await withLock(async () => {
      await saveLocalStore(store);
    });
  }

  return userDevices;
}

/**
 * Records a heartbeat from a connected device using its Bearer token.
 */
export async function recordDeviceHeartbeat(
  deviceAuthToken: string
): Promise<SanitizedDevice | null> {
  const tokenHash = hashToken(deviceAuthToken);
  const nowIso = new Date().toISOString();

  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("ultron_devices")
        .update({
          last_seen_at: nowIso,
          connection_status: "connected",
        })
        .eq("device_token_hash", tokenHash)
        .select()
        .maybeSingle();

      if (!error && data) {
        const updated = mapRowToDevice(data as DbDeviceRow);
        // Also sync local cache
        await withLock(async () => {
          const store = await loadLocalStore();
          store.devices[updated.deviceId] = updated;
          await saveLocalStore(store);
        });
        return sanitizeDevice(updated);
      }
    } catch (err) {
      console.warn("[ULTRON DB] Supabase recordDeviceHeartbeat error:", err);
    }
  }

  // Fallback to local store
  return withLock(async () => {
    const store = await loadLocalStore();
    let foundDevice: StoredDevice | null = null;

    for (const device of Object.values(store.devices)) {
      if (device.deviceTokenHash === tokenHash) {
        device.lastSeenAt = nowIso;
        device.connectionStatus = "connected";
        foundDevice = device;
        break;
      }
    }

    if (foundDevice) {
      await saveLocalStore(store);
      return sanitizeDevice(foundDevice);
    }
    return null;
  });
}

/**
 * Verifies a device authentication token and returns the sanitized device.
 */
export async function verifyDeviceToken(
  deviceAuthToken: string
): Promise<SanitizedDevice | null> {
  const tokenHash = hashToken(deviceAuthToken);

  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("ultron_devices")
        .select("*")
        .eq("device_token_hash", tokenHash)
        .maybeSingle();

      if (!error && data) {
        return sanitizeDevice(mapRowToDevice(data as DbDeviceRow));
      }
    } catch (err) {
      console.warn("[ULTRON DB] Supabase verifyDeviceToken error:", err);
    }
  }

  // Fallback to local store
  const store = await loadLocalStore();
  for (const device of Object.values(store.devices)) {
    if (device.deviceTokenHash === tokenHash) {
      return sanitizeDevice(device);
    }
  }
  return null;
}

/**
 * Updates the connection status for a specific device.
 */
export async function setDeviceConnectionStatus(
  deviceId: string,
  status: "connected" | "offline"
): Promise<boolean> {
  const nowIso = new Date().toISOString();

  const supabase = getSupabase();
  if (supabase) {
    try {
      const updatePayload: Record<string, string> = { connection_status: status };
      if (status === "connected") {
        updatePayload.last_seen_at = nowIso;
      }
      const { error } = await supabase
        .from("ultron_devices")
        .update(updatePayload)
        .eq("device_id", deviceId);

      if (!error) {
        // Sync local
        await withLock(async () => {
          const store = await loadLocalStore();
          const dev = store.devices[deviceId];
          if (dev) {
            dev.connectionStatus = status;
            if (status === "connected") dev.lastSeenAt = nowIso;
            await saveLocalStore(store);
          }
        });
        return true;
      }
    } catch (err) {
      console.warn("[ULTRON DB] Supabase setDeviceConnectionStatus error:", err);
    }
  }

  // Fallback to local store
  return withLock(async () => {
    const store = await loadLocalStore();
    const device = store.devices[deviceId];
    if (!device) return false;

    device.connectionStatus = status;
    if (status === "connected") {
      device.lastSeenAt = nowIso;
    }
    await saveLocalStore(store);
    return true;
  });
}

/**
 * Unpairs a device belonging to the authenticated user.
 * Enforces strict ownership check.
 */
export async function unpairDevice(
  userId: string,
  deviceId: string
): Promise<boolean> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("ultron_devices")
        .delete()
        .eq("device_id", deviceId)
        .eq("user_id", userId)
        .select();

      if (!error && Array.isArray(data) && data.length > 0) {
        // Also remove from local
        await withLock(async () => {
          const store = await loadLocalStore();
          delete store.devices[deviceId];
          await saveLocalStore(store);
        });
        return true;
      }
    } catch (err) {
      console.warn("[ULTRON DB] Supabase unpairDevice error:", err);
    }
  }

  // Fallback to local store
  return withLock(async () => {
    const store = await loadLocalStore();
    const device = store.devices[deviceId];

    // Device does not exist or belongs to another user
    if (!device || device.userId !== userId) {
      return false;
    }

    delete store.devices[deviceId];
    await saveLocalStore(store);
    return true;
  });
}

/**
 * Resets/clears pairing sessions (useful for tests).
 */
export function _clearPairingSessionsForTest(): void {
  activePairingSessions.clear();
}
