"use client";

import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    // 1. Check URL query parameters for OAuth errors or registered status
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const err = params.get("error_description") || params.get("error");
      if (err) {
        if (err === "auth_code_missing") {
          setErrorMsg("Authentication code missing. Please sign in again.");
        } else {
          setErrorMsg(decodeURIComponent(err));
        }
      }
      if (params.get("registered") === "true") {
        setSuccessMsg("Account registered successfully! Please sign in with your credentials.");
      }
    }

    // 2. If already authenticated, redirect to main application
    if (isSupabaseConfigured()) {
      try {
        const supabase = createClient();
        supabase.auth.getUser().then(({ data: { user }, error }) => {
          if (user && !error) {
            window.location.href = "/";
          }
        });
      } catch {
        // Ignore initialization error during check
      }
    }
  }, []);

  const handleEmailLogin = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setErrorMsg("Please enter both email and password.");
      return;
    }

    if (!isSupabaseConfigured()) {
      setErrorMsg(
        "Supabase authentication is not configured. Please define NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your environment."
      );
      return;
    }

    try {
      setLoading(true);
      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });

      if (error) {
        setErrorMsg(error.message);
        setLoading(false);
        return;
      }

      if (data.session) {
        try {
          await fetch("/api/auth/session", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${data.session.access_token}`,
            },
          });
        } catch {
          // Fallback
        }
        window.location.assign("/");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to sign in.";
      setErrorMsg(msg);
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      setGoogleLoading(true);
      setErrorMsg(null);
      setSuccessMsg(null);

      if (!isSupabaseConfigured()) {
        setErrorMsg(
          "Supabase authentication is not configured. Please define NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your environment."
        );
        setGoogleLoading(false);
        return;
      }

      const supabase = createClient();
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const redirectTo = `${origin}/auth/callback`;

      console.log("[ULTRON AUTH] Initiating Google OAuth flow, redirect to:", redirectTo);

      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          queryParams: {
            access_type: "offline",
            prompt: "consent",
          },
        },
      });

      if (error) {
        console.error("[ULTRON AUTH] Google signInWithOAuth error:", error);
        setErrorMsg(error.message);
        setGoogleLoading(false);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Authentication failed to start";
      console.error("[ULTRON AUTH] Unexpected error during login:", err);
      setErrorMsg(msg);
      setGoogleLoading(false);
    }
  };

  const handleGuestLogin = async () => {
    if (isSubmitting) return;

    setErrorMsg(null);
    setSuccessMsg(null);

    if (!isSupabaseConfigured()) {
      setErrorMsg(
        "Supabase authentication is not configured. Please define NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your environment."
      );
      return;
    }

    try {
      setGuestLoading(true);
      const supabase = createClient();
      const { data, error } = await supabase.auth.signInAnonymously();

      if (error) {
        let msg = error.message;
        if (
          msg.toLowerCase().includes("anonymous sign-ins are disabled") ||
          error.status === 422
        ) {
          msg =
            "Supabase Anonymous Sign-In is disabled. Please enable it in the Supabase Dashboard under Authentication -> Providers -> Anonymous Sign-Ins.";
        }
        setErrorMsg(msg);
        setGuestLoading(false);
        return;
      }

      if (data?.session || data?.user) {
        // Synchronize and establish the signed session cookie before navigation
        try {
          await fetch("/api/auth/session", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(data.session?.access_token
                ? { Authorization: `Bearer ${data.session.access_token}` }
                : {}),
            },
          });
        } catch {
          // Session cookie establishment fallback
        }
        window.location.assign("/");
      } else {
        setErrorMsg("Unable to establish guest session. Please try again.");
        setGuestLoading(false);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to start guest session.";
      setErrorMsg(msg);
      setGuestLoading(false);
    }
  };

  const isSubmitting = loading || googleLoading || guestLoading;

  return (
    <main className="login-root">
      {/* Visual background overlays */}
      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="login-card" role="region" aria-label="ULTRON Access Protocol">
        {/* Header HUD Element */}
        <div className="login-hud-tag">SYSTEM ACCESS PROTOCOL // AUTH-01</div>

        <h1 className="login-title">Welcome to ULTRON</h1>
        <p className="login-subtitle">Sign in to continue</p>

        <div className="login-divider" />

        <div className="login-body">
          {successMsg && (
            <div className="login-success" role="status">
              <span className="login-success-prefix">STATUS:</span>
              <span>{successMsg}</span>
            </div>
          )}

          {errorMsg && (
            <div className="login-error" role="alert">
              <span className="login-error-prefix">SECURITY ALERT:</span>
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleEmailLogin} className="login-form">
            <div className="login-input-group">
              <label htmlFor="login-email" className="login-input-label">
                EMAIL ADDRESS
              </label>
              <input
                id="login-email"
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operator@ultron.ai"
                required
                disabled={isSubmitting}
                className="login-input"
              />
            </div>

            <div className="login-input-group">
              <label htmlFor="login-password" className="login-input-label">
                PASSWORD
              </label>
              <input
                id="login-password"
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                required
                disabled={isSubmitting}
                className="login-input"
              />
            </div>

            <button
              type="submit"
              id="btn-email-login"
              className="login-btn-primary"
              disabled={isSubmitting}
            >
              {loading ? "AUTHENTICATING…" : "SIGN IN"}
            </button>
          </form>

          <div className="login-or-divider">OR</div>

          <button
            type="button"
            id="btn-google-login"
            className="login-btn-google"
            onClick={handleGoogleLogin}
            disabled={isSubmitting}
            aria-label="Continue with Google"
          >
            {googleLoading ? (
              <span>INITIALIZING SECURE LINK…</span>
            ) : (
              <>
                <svg
                  className="login-google-icon"
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  aria-hidden="true"
                >
                  <path
                    fill="#EA4335"
                    d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.5 1 3.7 3.6 1.9 7.3l3.7 2.9C6.5 7.3 9 5 12 5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.7l3.7 2.9c2.2-2 3.7-5 3.7-8.8z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.6 14.8c-.2-.7-.4-1.5-.4-2.3s.2-1.6.4-2.3L1.9 7.3C.7 9.7 0 12 0 14.5s.7 4.8 1.9 7.2l3.7-2.9z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23.5c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3 0-5.5-2.3-6.4-5.2L1.9 16.5C3.7 20.2 7.5 23.5 12 23.5z"
                  />
                </svg>
                <span>Continue with Google</span>
              </>
            )}
          </button>

          <button
            type="button"
            id="btn-guest-login"
            className="login-btn-guest"
            onClick={handleGuestLogin}
            disabled={isSubmitting}
            aria-label="Continue as Guest"
          >
            {guestLoading ? "ESTABLISHING GUEST SESSION…" : "CONTINUE AS GUEST"}
          </button>

          <div className="login-switch-link">
            <span>Don&apos;t have an account?</span>{" "}
            <Link href="/register" style={{ color: "#ffaa30", fontWeight: "bold" }}>
              Create account
            </Link>
          </div>
        </div>

        <div className="login-footer">
          <span>SECURED VIA SUPABASE AUTH</span>
          <span>ULTRON CORE v1.0.0</span>
        </div>
      </div>
    </main>
  );
}
