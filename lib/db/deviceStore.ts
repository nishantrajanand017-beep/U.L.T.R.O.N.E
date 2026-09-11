import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

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

const DATA_DIR = path.join(process.cwd(), "data");
const DEVICES_FILE = path.join(DATA_DIR, "user_devices.json");

// In-memory pairing sessions map (short-lived 5-minute sessions)
const activePairingSessions = new Map<string, PairingSession>();

// In-memory mutex for file writing
let writeLock: Promise<void> = Promise.resolve();

// Devices silent for longer than this threshold are considered offline
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

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

async function loadStore(): Promise<DeviceStoreData> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(DEVICES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as DeviceStoreData;
    if (parsed && typeof parsed.devices === "object") {
      return parsed;
    }
  } catch {
    // File does not exist yet or is empty
  }
  return { version: 1, devices: {} };
}

async function saveStore(data: DeviceStoreData): Promise<void> {
  await ensureDataDir();
  const tmpFile = `${DEVICES_FILE}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpFile, content, "utf-8");

  let renamed = false;
  for (let i = 0; i < 5; i++) {
    try {
      await fs.rename(tmpFile, DEVICES_FILE);
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
    await fs.writeFile(DEVICES_FILE, content, "utf-8");
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

// Prune expired pairing sessions
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
 */
export function createPairingSession(userId: string): {
  code: string;
  expiresAt: number;
  expiresInSeconds: number;
} {
  pruneExpiredSessions();

  // Generate clean, human-readable 6-character uppercase alphanumeric code e.g. "7AF49C"
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const expiresAt = Date.now() + PAIRING_SESSION_TTL_MS;

  activePairingSessions.set(code, {
    code,
    userId,
    expiresAt,
    used: false,
  });

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
  const session = activePairingSessions.get(normalizedCode);

  if (!session) {
    throw new Error("Invalid or unknown pairing code.");
  }

  if (Date.now() > session.expiresAt) {
    activePairingSessions.delete(normalizedCode);
    throw new Error("Pairing code has expired. Please generate a new code.");
  }

  if (session.used) {
    activePairingSessions.delete(normalizedCode);
    throw new Error("Pairing code has already been used.");
  }

  // Atomically invalidate code
  session.used = true;
  activePairingSessions.delete(normalizedCode);

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

  await withLock(async () => {
    const store = await loadStore();
    store.devices[deviceId] = newDevice;
    await saveStore(store);
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
  const store = await loadStore();
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
      await saveStore(store);
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

  return withLock(async () => {
    const store = await loadStore();
    let foundDevice: StoredDevice | null = null;

    for (const device of Object.values(store.devices)) {
      if (device.deviceTokenHash === tokenHash) {
        device.lastSeenAt = new Date().toISOString();
        device.connectionStatus = "connected";
        foundDevice = device;
        break;
      }
    }

    if (foundDevice) {
      await saveStore(store);
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
  const store = await loadStore();

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
  return withLock(async () => {
    const store = await loadStore();
    const device = store.devices[deviceId];
    if (!device) return false;

    device.connectionStatus = status;
    if (status === "connected") {
      device.lastSeenAt = new Date().toISOString();
    }
    await saveStore(store);
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
  return withLock(async () => {
    const store = await loadStore();
    const device = store.devices[deviceId];

    // Device does not exist or belongs to another user
    if (!device || device.userId !== userId) {
      return false;
    }

    delete store.devices[deviceId];
    await saveStore(store);
    return true;
  });
}

/**
 * Resets/clears pairing sessions (useful for tests).
 */
export function _clearPairingSessionsForTest(): void {
  activePairingSessions.clear();
}
