import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Validates and sanitizes a redirect target, allowing only safe internal relative paths.
 * Rejects absolute URLs, protocol-relative URLs (//...), backslash bypasses (/\\...), and javascript: URIs.
 */
export function getSafeRedirectPath(rawNext: string | null): string {
  if (!rawNext || typeof rawNext !== "string") {
    return "/";
  }

  const trimmed = rawNext.trim();

  // Must start with exactly one forward slash, not protocol-relative (//) or backslash (/\)
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) {
    return "/";
  }

  // Must not contain backslashes anywhere
  if (trimmed.includes("\\")) {
    return "/";
  }

  // Must not contain scheme indicators in the path (e.g. javascript:, https:)
  const pathOnly = trimmed.split("?")[0].split("#")[0];
  if (pathOnly.includes(":")) {
    return "/";
  }

  try {
    const dummyOrigin = "http://localhost";
    const parsed = new URL(trimmed, dummyOrigin);
    if (parsed.origin !== dummyOrigin) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next");
  const safeNext = getSafeRedirectPath(rawNext);

  if (code) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);

      if (!error) {
        const forwardedHost = request.headers.get("x-forwarded-host");
        const isLocalEnv = process.env.NODE_ENV === "development";

        if (isLocalEnv) {
          return NextResponse.redirect(`${origin}${safeNext}`);
        } else if (forwardedHost) {
          return NextResponse.redirect(`https://${forwardedHost}${safeNext}`);
        } else {
          return NextResponse.redirect(`${origin}${safeNext}`);
        }
      } else {
        console.error("[Auth Callback] Exchange code error:", error.message);
        return NextResponse.redirect(
          `${origin}/login?error=${encodeURIComponent(error.message)}`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Authentication code exchange failed";
      console.error("[Auth Callback] Unexpected error:", err);
      return NextResponse.redirect(
        `${origin}/login?error=${encodeURIComponent(msg)}`
      );
    }
  }

  // Return to login with error param if code missing
  return NextResponse.redirect(`${origin}/login?error=auth_code_missing`);
}

