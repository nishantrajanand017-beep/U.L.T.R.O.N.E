import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE_NAME = "ultron_session_id";

function hasValidSessionCookieFormat(cookieValue: string | undefined): boolean {
  if (!cookieValue || typeof cookieValue !== "string") return false;
  const dotIdx = cookieValue.lastIndexOf(".");
  return dotIdx > 0 && dotIdx < cookieValue.length - 1;
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });
  const { pathname } = request.nextUrl;

  // Do not intercept static files, internal Next.js assets, API routes, or OAuth callback
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/api") ||
    pathname.includes(".")
  ) {
    return supabaseResponse;
  }

  const isPublicAuthRoute = pathname === "/login" || pathname === "/register";

  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const hasValidSignedSession = hasValidSessionCookieFormat(sessionCookie);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();

  // If Supabase is not configured, fallback to signed session token check
  if (!supabaseUrl || !supabaseKey || supabaseUrl.includes("your_supabase")) {
    if (!hasValidSignedSession && !isPublicAuthRoute) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      return NextResponse.redirect(url);
    }
    if (hasValidSignedSession && isPublicAuthRoute) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return supabaseResponse;
  }

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // Refresh auth session
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthenticated = Boolean(user || hasValidSignedSession);

  // Helper to construct a redirect preserving any cookies refreshed by Supabase SSR
  const createRedirectWithCookies = (destination: string) => {
    const url = request.nextUrl.clone();
    url.pathname = destination;
    const redirectResponse = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie.name, cookie.value, cookie);
    });
    return redirectResponse;
  };

  // If unauthenticated and accessing protected routes, redirect to /login
  if (!isAuthenticated && !isPublicAuthRoute) {
    return createRedirectWithCookies("/login");
  }

  // If authenticated and visiting /login or /register, redirect to main ULTRON app (/)
  if (isAuthenticated && isPublicAuthRoute) {
    return createRedirectWithCookies("/");
  }

  return supabaseResponse;
}
