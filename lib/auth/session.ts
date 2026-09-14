import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createClient as createServerClient } from "@/lib/supabase/server";

export const SESSION_COOKIE_NAME = "ultron_session_id";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

/**
 * Derives a cryptographic key for signing and verifying ULTRON session tokens.
 */
function getSessionSecret(): Buffer {
  const secret =
    process.env.ENCRYPTION_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "ultron-default-secret-salt-2026-phase-9-secure-key";

  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Creates an HMAC-SHA256 signed session token: "<sanitizedUserId>.<hmacHex>"
 */
export function createSignedSessionToken(userId: string): string {
  const sanitized = sanitizeUserId(userId);
  const hmac = crypto
    .createHmac("sha256", getSessionSecret())
    .update(sanitized)
    .digest("hex");

  return `${sanitized}.${hmac}`;
}

/**
 * Verifies the HMAC-SHA256 signature on an ULTRON session token.
 * Uses timingSafeEqual to protect against timing attacks.
 * Returns the verified userId if valid, or null if tampered/invalid/unsigned.
 */
export function verifySignedSessionToken(token: string): string | null {
  if (!token || typeof token !== "string") {
    return null;
  }

  const dotIdx = token.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === token.length - 1) {
    return null;
  }

  const rawUserId = token.substring(0, dotIdx);
  const signature = token.substring(dotIdx + 1);

  const sanitized = sanitizeUserId(rawUserId);
  if (!sanitized || sanitized !== rawUserId) {
    return null;
  }

  const expectedHmac = crypto
    .createHmac("sha256", getSessionSecret())
    .update(sanitized)
    .digest("hex");

  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expectedHmac, "hex");

    if (sigBuf.length !== expBuf.length) {
      return null;
    }

    if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    return sanitized;
  } catch {
    return null;
  }
}

export interface ResolvedSession {
  userId: string | null;
  isAuthenticated: boolean;
  isNew?: boolean;
}

/**
 * Hardened user session resolution.
 *
 * Identity is determined strictly from:
 * 1. Verified Supabase server-side session (cookies or verified Bearer token).
 * 2. Cryptographically signed ULTRON session cookie (ultron_session_id).
 *
 * CRITICAL SECURITY CONSTRAINTS:
 * - The server MUST NOT trust x-ultron-user-id as an authenticated identity.
 * - The server MUST NOT treat Authorization: Bearer <arbitrary-string> as a user ID.
 * - If an unauthenticated caller sends x-ultron-user-id, it is REJECTED.
 * - If an authenticated user sends x-ultron-user-id: victim, it is IGNORED (identity remains authenticated user).
 * - Unauthenticated requests return userId = null and isAuthenticated = false.
 */
export async function resolveUserSession(request: Request): Promise<ResolvedSession> {
  // 1. Inspect Supabase authentication if configured
  if (isSupabaseConfigured()) {
    try {
      // Check Authorization: Bearer <token>
      const authHeader = request.headers.get("authorization");
      if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
        const token = authHeader.slice(7).trim();
        if (token) {
          try {
            const supabase = await createServerClient();
            const {
              data: { user },
              error,
            } = await supabase.auth.getUser(token);

            if (user && !error) {
              return { userId: user.id, isAuthenticated: true, isNew: false };
            }
          } catch {
            // Failed Supabase verification
          }
          // An arbitrary bearer token that fails Supabase verification is rejected
          return { userId: null, isAuthenticated: false, isNew: false };
        }
      }

      // Check Supabase session from cookies
      try {
        const supabase = await createServerClient();
        const {
          data: { user },
          error,
        } = await supabase.auth.getUser();

        if (user && !error) {
          return { userId: user.id, isAuthenticated: true, isNew: false };
        }
      } catch {
        // Ignored if called outside Next.js request context
      }
    } catch (err) {
      console.warn("[Auth] Supabase verification error:", err);
    }
  }

  // 2. Inspect cryptographically signed ULTRON session cookie
  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const cookies = cookieHeader.split(";").map((c) => c.trim());
    for (const cookie of cookies) {
      if (cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
        const val = cookie.slice(`${SESSION_COOKIE_NAME}=`.length).trim();
        if (val) {
          const verified = verifySignedSessionToken(val);
          if (verified) {
            return { userId: verified, isAuthenticated: true, isNew: false };
          }
          // Cookie was provided but signature is invalid or tampered
          return { userId: null, isAuthenticated: false, isNew: false };
        }
      }
    }
  }

  // 3. If there is no valid authenticated session, return unauthenticated
  // Never trust client-supplied headers (e.g. x-ultron-user-id) as an identity
  return { userId: null, isAuthenticated: false, isNew: false };
}

/**
 * Attaches the cryptographically signed session cookie to a NextResponse.
 */
export function attachSessionCookie(
  response: NextResponse,
  userId: string
): NextResponse {
  const signedToken = createSignedSessionToken(userId);

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: signedToken,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });

  return response;
}

export function sanitizeUserId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

