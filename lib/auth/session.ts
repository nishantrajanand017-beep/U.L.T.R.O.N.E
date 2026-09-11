import crypto from "node:crypto";
import { NextResponse } from "next/server";

export const SESSION_COOKIE_NAME = "ultron_session_id";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

/**
 * Extracts the user identifier from request cookies, authorization headers, or custom header.
 * Ensures consistent per-user isolation.
 */
export function getUserIdFromRequest(request: Request): string | null {
  // 1. Check custom header (useful for programmatic testing / client isolation)
  const headerUserId = request.headers.get("x-ultron-user-id");
  if (headerUserId && headerUserId.trim().length > 0) {
    return sanitizeUserId(headerUserId.trim());
  }

  // 2. Check Authorization Bearer header
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const bearerVal = authHeader.slice(7).trim();
    if (bearerVal) {
      return sanitizeUserId(bearerVal);
    }
  }

  // 3. Check Cookie header
  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const cookies = cookieHeader.split(";").map((c) => c.trim());
    for (const cookie of cookies) {
      if (cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
        const val = cookie.slice(`${SESSION_COOKIE_NAME}=`.length).trim();
        if (val) {
          return sanitizeUserId(val);
        }
      }
    }
  }

  return null;
}

/**
 * Returns an existing userId or generates a new secure unique ID.
 * Returns the resolved userId and whether a new cookie should be attached to the response.
 */
export function resolveUserSession(request: Request): {
  userId: string;
  isNew: boolean;
} {
  const existing = getUserIdFromRequest(request);
  if (existing) {
    return { userId: existing, isNew: false };
  }

  // Generate new anonymous isolated user session
  const newUserId = `usr_${crypto.randomBytes(16).toString("hex")}`;
  return { userId: newUserId, isNew: true };
}

/**
 * Attaches the secure session cookie to a NextResponse if the user session is new.
 */
export function attachSessionCookie(
  response: NextResponse,
  userId: string
): NextResponse {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: userId,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

function sanitizeUserId(id: string): string {
  // Only allow alphanumeric, underscore, hyphen to prevent path injection
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}
