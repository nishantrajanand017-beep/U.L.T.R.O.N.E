/**
 * Server-Side In-Memory and Realtime Device Catalog Store.
 * Holds discovered launcher application catalogs reported by companion devices.
 */

import { getSupabase } from "./deviceStore";

export interface CatalogAppEntry {
  appId: string;
  displayName: string;
  packageName?: string;
}

// In-memory catalog cache for sub-millisecond same-instance lookup
const catalogStore = new Map<string, CatalogAppEntry[]>();

/**
 * Normalizes an application identifier: lowercase alphanumeric, hyphens, and underscores only.
 */
export function sanitizeAppId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-\.]/g, "")
    .slice(0, 64);
}

/**
 * Normalizes a display name: strips control chars, max 64 chars.
 */
export function sanitizeDisplayName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "").trim().slice(0, 64);
}

/**
 * Stores or updates the discovered application catalog for a device.
 * Persists to Supabase database for multi-instance Vercel serverless persistence.
 */
export async function setDeviceCatalog(
  deviceId: string,
  apps: Array<{ appId: string; displayName: string; packageName?: string }>
): Promise<void> {
  if (!deviceId) return;

  const validEntries: CatalogAppEntry[] = [];
  const seenIds = new Set<string>();

  for (const item of apps) {
    const appId = sanitizeAppId(item.appId);
    const displayName = sanitizeDisplayName(item.displayName) || appId;
    if (appId && !seenIds.has(appId)) {
      seenIds.add(appId);
      validEntries.push({
        appId,
        displayName,
        ...(item.packageName ? { packageName: String(item.packageName).trim() } : {}),
      });
    }
  }

  // Update in-memory cache
  catalogStore.set(deviceId, validEntries);

  // Persist to Supabase database for Vercel serverless cross-instance access
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from("ultron_device_catalogs").upsert({
        device_id: deviceId,
        catalog: validEntries,
        updated_at: new Date().toISOString(),
      });
      if (error && error.code !== "PGRST205") {
        console.warn("[Catalog Store] Failed to persist catalog in Supabase:", error.message);
      }
    } catch (err) {
      console.warn("[Catalog Store] Supabase upsert error:", err);
    }
  }
}

/**
 * Retrieves the application catalog for a device.
 * Checks in-memory cache first, falls back to Supabase database if on a fresh Vercel container.
 */
export async function getDeviceCatalog(deviceId: string): Promise<CatalogAppEntry[]> {
  if (!deviceId) return [];

  // 1. Fast path: check in-memory cache
  const cached = catalogStore.get(deviceId);
  if (cached && cached.length > 0) {
    return cached;
  }

  // 2. Persistent path: query Supabase database across serverless invocations
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("ultron_device_catalogs")
        .select("catalog")
        .eq("device_id", deviceId)
        .maybeSingle();

      if (!error && data?.catalog && Array.isArray(data.catalog)) {
        const entries = data.catalog as CatalogAppEntry[];
        catalogStore.set(deviceId, entries);
        return entries;
      }
    } catch (err) {
      console.warn("[Catalog Store] Supabase query error:", err);
    }
  }

  return cached || [];
}

/**
 * Looks up an appId in the device's discovered catalog.
 */
export async function findInDeviceCatalog(
  deviceId: string,
  appId: string
): Promise<CatalogAppEntry | null> {
  const normId = sanitizeAppId(appId);
  if (!normId) return null;

  const catalog = await getDeviceCatalog(deviceId);
  return catalog.find((entry) => entry.appId === normId) || null;
}

/**
 * Clears the catalog for a device (e.g. upon unpairing).
 */
export async function clearDeviceCatalog(deviceId: string): Promise<void> {
  catalogStore.delete(deviceId);

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("ultron_device_catalogs").delete().eq("device_id", deviceId);
    } catch {
      // ignore
    }
  }
}
