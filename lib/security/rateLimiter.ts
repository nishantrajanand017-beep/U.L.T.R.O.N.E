/**
 * lib/security/rateLimiter.ts
 *
 * Distributed, multi-instance rate limiter for ULTRON APIs.
 * Architecture:
 * 1. Primary (Production): Shared Supabase PostgreSQL table & atomic stored procedure
 *    (public.check_rate_limit) using row-level locking (SELECT ... FOR UPDATE).
 *    Works reliably across distributed Vercel serverless instances.
 * 2. Fallback (Development/Offline): In-memory sliding window counter for offline
 *    development, unit tests, or temporary database degradation.
 * 3. Scoped strictly by verified authenticated user ID (never spoofable headers).
 * 4. Distinct limits per endpoint (Chat: 20/min, STT: 15/min, TTS: 60/min to accommodate
 *    VoiceMode sentence chunking).
 * 5. Returns standard HTTP 429 with Retry-After and rate limit headers.
 */

import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/db/deviceStore";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // epoch ms
  retryAfter: number; // seconds
  source: "supabase" | "memory_fallback";
}

interface MemoryRateLimitEntry {
  count: number;
  windowStart: number;
}

const memoryStore = new Map<string, MemoryRateLimitEntry>();

// Periodic cleanup of expired entries in memory fallback
if (typeof setInterval !== "undefined") {
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryStore.entries()) {
      if (now - entry.windowStart > 300_000) {
        memoryStore.delete(key);
      }
    }
  }, 300_000);
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

/**
 * Gets configured limits from environment with safe defaults.
 * Note: TTS is 60 req/min because VoiceMode chunks responses into ~65-100 character
 * segments, meaning a single long assistant response can legitimately generate 10-20 requests.
 */
export function getEndpointLimit(endpoint: "chat" | "stt" | "tts"): {
  maxRequests: number;
  windowMs: number;
} {
  const windowMs = 60_000; // 1 minute window

  switch (endpoint) {
    case "chat":
      return {
        maxRequests: parseInt(process.env.RATE_LIMIT_CHAT_PER_MINUTE || "20", 10),
        windowMs,
      };
    case "stt":
      return {
        maxRequests: parseInt(process.env.RATE_LIMIT_STT_PER_MINUTE || "15", 10),
        windowMs,
      };
    case "tts":
      return {
        maxRequests: parseInt(process.env.RATE_LIMIT_TTS_PER_MINUTE || "60", 10),
        windowMs,
      };
  }
}

/**
 * Executes an in-memory rate-limit check (used for local dev or offline fallback).
 */
export function checkMemoryRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  let entry = memoryStore.get(key);

  if (!entry || now - entry.windowStart >= windowMs) {
    // New or expired window
    entry = { count: 1, windowStart: now };
    memoryStore.set(key, entry);
    return {
      allowed: true,
      limit: maxRequests,
      remaining: Math.max(0, maxRequests - 1),
      resetAt: now + windowMs,
      retryAfter: 0,
      source: "memory_fallback",
    };
  }

  const resetAt = entry.windowStart + windowMs;
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));

  if (entry.count < maxRequests) {
    entry.count += 1;
    return {
      allowed: true,
      limit: maxRequests,
      remaining: Math.max(0, maxRequests - entry.count),
      resetAt,
      retryAfter: 0,
      source: "memory_fallback",
    };
  }

  // Quota exceeded
  return {
    allowed: false,
    limit: maxRequests,
    remaining: 0,
    resetAt,
    retryAfter,
    source: "memory_fallback",
  };
}

/**
 * Checks and increments rate limit for a specific key.
 * Primary: Distributed Supabase RPC (multi-instance serverless safe).
 * Fallback: Local in-memory sliding window.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult> {
  const supabase = getSupabase();

  if (supabase) {
    try {
      const { data, error } = await supabase.rpc("check_rate_limit", {
        p_key: key,
        p_window_ms: windowMs,
        p_max_requests: maxRequests,
      });

      if (!error && Array.isArray(data) && data.length > 0) {
        const row = data[0];
        const resetAt = typeof row.reset_at === "number" ? row.reset_at : Number(row.reset_at);
        const retryAfter = typeof row.retry_after === "number" ? row.retry_after : Number(row.retry_after);
        const remaining = typeof row.remaining === "number" ? row.remaining : Number(row.remaining);

        return {
          allowed: Boolean(row.allowed),
          limit: maxRequests,
          remaining: Math.max(0, remaining),
          resetAt,
          retryAfter,
          source: "supabase",
        };
      }
    } catch {
      // Supabase RPC unavailable or failed, smoothly use memory fallback
    }
  }

  return checkMemoryRateLimit(key, maxRequests, windowMs);
}

/**
 * High-level rate limiter helper scoped by endpoint and verified userId.
 */
export async function checkEndpointRateLimit(
  endpoint: "chat" | "stt" | "tts",
  userId: string,
  ip?: string | null,
  testLimit?: number
): Promise<RateLimitResult> {
  const { maxRequests: configuredMax, windowMs } = getEndpointLimit(endpoint);
  const maxRequests =
    process.env.NODE_ENV !== "production" && testLimit && testLimit > 0
      ? testLimit
      : configuredMax;

  // Primary user-scoped key: e.g. "ratelimit:chat:usr_12345"
  const userKey = `ratelimit:${endpoint}:${userId}`;
  const userResult = await checkRateLimit(userKey, maxRequests, windowMs);

  if (!userResult.allowed) {
    return userResult;
  }

  // Secondary IP-scoped abuse limit if IP is provided (generous multiplier to catch unauthenticated flood)
  if (ip && ip !== "127.0.0.1" && ip !== "::1") {
    const ipMax = maxRequests * 5; // 5x allowance for shared NAT/proxies
    const ipKey = `ratelimit:${endpoint}:ip:${ip}`;
    const ipResult = await checkRateLimit(ipKey, ipMax, windowMs);
    if (!ipResult.allowed) {
      return ipResult;
    }
  }

  return userResult;
}

/**
 * Builds standard RFC-compliant rate limit response headers.
 */
export function createRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };

  if (!result.allowed && result.retryAfter > 0) {
    headers["Retry-After"] = String(result.retryAfter);
  }

  return headers;
}

/**
 * Generates standard HTTP 429 Too Many Requests response.
 */
export function createRateLimitErrorResponse(result: RateLimitResult): NextResponse {
  return NextResponse.json(
    {
      error: "rate_limit_exceeded",
      message: `Too many requests. Rate limit exceeded. Please retry in ${result.retryAfter} seconds.`,
      retryAfter: result.retryAfter,
    },
    {
      status: 429,
      headers: createRateLimitHeaders(result),
    }
  );
}

/**
 * Resets a rate limit key (strictly for automated testing).
 */
export function resetMemoryRateLimit(keyPrefix?: string): void {
  if (!keyPrefix) {
    memoryStore.clear();
  } else {
    for (const key of memoryStore.keys()) {
      if (key.includes(keyPrefix)) {
        memoryStore.delete(key);
      }
    }
  }
}
