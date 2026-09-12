/**
 * Centralized Server-Side Application Allowlist for ULTRON Companion.
 * Maps safe, approved logical application IDs to their official Android package identifiers.
 *
 * Security Rules:
 * 1. Only vetted, non-sensitive applications are permitted.
 * 2. Sensitive apps (banking, payment, password managers, authenticators) are strictly forbidden.
 * 3. Never trust arbitrary package names supplied by clients.
 */

export interface AllowedAppConfig {
  appId: string;
  name: string;
  packageName: string;
  category: "messaging" | "browser" | "media" | "email" | "system";
}

export const APPROVED_APPS: Record<string, AllowedAppConfig> = {
  whatsapp: {
    appId: "whatsapp",
    name: "WhatsApp",
    packageName: "com.whatsapp",
    category: "messaging",
  },
  telegram: {
    appId: "telegram",
    name: "Telegram",
    packageName: "org.telegram.messenger",
    category: "messaging",
  },
  chrome: {
    appId: "chrome",
    name: "Google Chrome",
    packageName: "com.android.chrome",
    category: "browser",
  },
  youtube: {
    appId: "youtube",
    name: "YouTube",
    packageName: "com.google.android.youtube",
    category: "media",
  },
  gmail: {
    appId: "gmail",
    name: "Gmail",
    packageName: "com.google.android.gm",
    category: "email",
  },
  settings: {
    appId: "settings",
    name: "Settings",
    packageName: "com.android.settings",
    category: "system",
  },
};

/**
 * Resolves a logical appId against the approved allowlist.
 * Returns the validated configuration or null if not found or unauthorized.
 */
export function resolveApprovedApp(appId: unknown): AllowedAppConfig | null {
  if (!appId || typeof appId !== "string") {
    return null;
  }
  const normalized = appId.trim().toLowerCase();
  return APPROVED_APPS[normalized] || null;
}

/**
 * Returns a list of all approved apps for UI selection.
 */
export function getApprovedAppsList(): AllowedAppConfig[] {
  return Object.values(APPROVED_APPS);
}
