/**
 * lib/ai/inferenceHealth.ts
 *
 * Server-only health diagnostic probe for remote/local AI inference services.
 * Tests connectivity and readiness for Qwen, Whisper, and Kokoro.
 *
 * Security Constraints:
 * 1. Executes strictly server-side.
 * 2. Uses finite short timeouts (3 seconds) to prevent hanging health checks.
 * 3. Sanitized outputs: NEVER leaks internal URLs, IP addresses, credentials,
 *    filesystem paths, or raw stack traces.
 */

import {
  InferenceProvider,
  getInferenceEndpoint,
  getInferenceAuthHeaders,
} from "./inferenceConfig";

export type HealthStatus = "healthy" | "unavailable";

export interface InferenceHealthReport {
  qwen: HealthStatus;
  whisper: HealthStatus;
  kokoro: HealthStatus;
  timestamp: string;
}

const HEALTH_PROBE_TIMEOUT_MS = 3_000; // 3-second quick probe

/**
 * Probes a specific inference provider to verify connectivity and readiness.
 * Returns strictly "healthy" or "unavailable".
 */
export async function checkProviderHealth(provider: InferenceProvider): Promise<HealthStatus> {
  try {
    const endpoint = getInferenceEndpoint(provider);
    const headers = getInferenceAuthHeaders(provider);
    const urlObj = new URL(endpoint);

    // Derive lightweight candidate probe URLs depending on provider and server type
    const probeUrls: string[] =
      provider === "qwen"
        ? [
            `${urlObj.origin}/health`,
            `${urlObj.origin}/healthz`,
            `${urlObj.origin}/v1/models`,
            endpoint,
          ]
        : [
            `${urlObj.origin}/health`,
            `${urlObj.origin}/healthz`,
            endpoint,
          ];

    for (const url of probeUrls) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
        });

        // 401/403: auth failure -> unavailable
        if (res.status === 401 || res.status === 403) {
          return "unavailable";
        }

        // 200-399 or 405 (Method Not Allowed): endpoint is active and reachable
        if ((res.status >= 200 && res.status < 400) || res.status === 405) {
          return "healthy";
        }

        // If 404, continue to next candidate
        if (res.status === 404) {
          continue;
        }

        if (res.status >= 500) {
          return "unavailable";
        }
      } catch {
        // Continue to next probe URL or fallback
        continue;
      }
    }

    // Secondary fallback: HEAD on main endpoint
    try {
      const headRes = await fetch(endpoint, {
        method: "HEAD",
        headers,
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });

      if (headRes.status !== 401 && headRes.status !== 403 && headRes.status < 500) {
        return "healthy";
      }
    } catch {
      // Network failure
    }

    return "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Checks all inference providers and compiles a safe, sanitized health report.
 */
export async function checkInferenceHealth(): Promise<InferenceHealthReport> {
  const [qwen, whisper, kokoro] = await Promise.all([
    checkProviderHealth("qwen"),
    checkProviderHealth("whisper"),
    checkProviderHealth("kokoro"),
  ]);

  return {
    qwen,
    whisper,
    kokoro,
    timestamp: new Date().toISOString(),
  };
}
