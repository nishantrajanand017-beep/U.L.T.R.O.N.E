import { NextResponse } from "next/server";
import {
  resolveUserSession,
  attachSessionCookie,
  SESSION_COOKIE_NAME,
  createSignedSessionToken,
} from "@/lib/auth/session";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";

export async function POST(request: Request) {
  try {
    let resolvedUserId: string | null = null;
    let isAnonymous = false;

    // 1. If Supabase is configured, verify the session securely from Supabase
    if (isSupabaseConfigured()) {
      const authHeader = request.headers.get("authorization");
      const bearerToken =
        authHeader && authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : null;

      try {
        const supabase = await createServerClient();
        const {
          data: { user },
          error,
        } = bearerToken
          ? await supabase.auth.getUser(bearerToken)
          : await supabase.auth.getUser();

        if (user && !error) {
          isAnonymous = Boolean(
            user.is_anonymous || user.app_metadata?.provider === "anonymous"
          );
          resolvedUserId = isAnonymous
            ? (user.id.startsWith("guest_") ? user.id : `guest_${user.id}`)
            : user.id;
        }
      } catch (err) {
        console.warn("[Auth Session] Supabase verification error:", err);
      }
    }

    // 2. If Supabase verified a user, attach the signed ULTRON session cookie
    if (resolvedUserId) {
      const response = NextResponse.json({
        success: true,
        userId: resolvedUserId,
        isAnonymous,
      });

      attachSessionCookie(response, resolvedUserId);
      return response;
    }

    // 3. Fallback: Check if caller already has a valid signed session
    const existing = await resolveUserSession(request);
    if (existing.isAuthenticated && existing.userId) {
      const response = NextResponse.json({
        success: true,
        userId: existing.userId,
        isAnonymous: Boolean(existing.isAnonymous),
      });
      attachSessionCookie(response, existing.userId);
      return response;
    }

    // If no valid session could be verified
    return NextResponse.json(
      { error: "Unauthorized: No valid session to establish." },
      { status: 401 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to establish session.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  });
  return response;
}
