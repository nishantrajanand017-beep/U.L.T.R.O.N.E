/**
 * lib/security/concurrencyGuard.ts
 *
 * Per-instance inference backpressure and concurrency guard.
 * Protects inference-heavy endpoints from excessive simultaneous requests
 * and GPU/CPU resource starvation.
 *
 * Note on serverless: This operates as a per-instance backpressure guard
 * to protect the local process and active inference connections, while the
 * durable Supabase rate limiter provides global abuse protection across all instances.
 */

import { NextResponse } from "next/server";

export type InferenceResource = "chat" | "stt" | "tts";

const CONCURRENCY_LIMITS: Record<InferenceResource, number> = {
  chat: 5, // Qwen3-8B max concurrent inferences
  stt: 3,  // Whisper large-v3-turbo max concurrent transcriptions
  tts: 6,  // Kokoro-82M max concurrent synthesis jobs (permits VoiceMode chunk flow)
};

const activeCounts: Record<InferenceResource, number> = {
  chat: 0,
  stt: 0,
  tts: 0,
};

export interface ConcurrencySlot {
  success: boolean;
  active: number;
  limit: number;
  release: () => void;
}

/**
 * Attempts to acquire an active execution slot for an inference resource.
 * Must be released when the request finishes (success or error).
 */
export function acquireConcurrencySlot(resource: InferenceResource): ConcurrencySlot {
  const limit = parseInt(
    process.env[`MAX_CONCURRENT_${resource.toUpperCase()}`] ||
      String(CONCURRENCY_LIMITS[resource]),
    10
  );

  if (activeCounts[resource] >= limit) {
    return {
      success: false,
      active: activeCounts[resource],
      limit,
      release: () => {},
    };
  }

  activeCounts[resource] += 1;
  let released = false;

  const release = () => {
    if (!released) {
      released = true;
      activeCounts[resource] = Math.max(0, activeCounts[resource] - 1);
    }
  };

  return {
    success: true,
    active: activeCounts[resource],
    limit,
    release,
  };
}

/**
 * Creates an HTTP 503 response when active inference capacity is saturated.
 */
export function createConcurrencyErrorResponse(resource: InferenceResource): NextResponse {
  return NextResponse.json(
    {
      error: "service_busy",
      message: `The ${resource.toUpperCase()} inference service is currently at maximum capacity. Please retry shortly.`,
      retryAfter: 2,
    },
    {
      status: 503,
      headers: {
        "Retry-After": "2",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    }
  );
}

export function getActiveConcurrency(resource: InferenceResource): number {
  return activeCounts[resource];
}

export function resetConcurrencyCounts(): void {
  activeCounts.chat = 0;
  activeCounts.stt = 0;
  activeCounts.tts = 0;
}
