"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    // Check URL query parameters for errors
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const err = params.get("error_description") || params.get("error");
      if (err) {
        setErrorMsg(decodeURIComponent(err));
      }
    }
  }, []);

  const handleGoogleLogin = async () => {
    try {
      setLoading(true);
      setErrorMsg(null);

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
        setLoading(false);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Authentication failed to start";
      console.error("[ULTRON AUTH] Unexpected error during login:", err);
      setErrorMsg(msg);
      setLoading(false);
    }
  };

  return (
    <main className="login-root">
      {/* Visual background overlays */}
      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="login-card" role="region" aria-label="ULTRON Access Protocol">
        {/* Header HUD Element */}
        <div className="login-hud-tag">SYSTEM ACCESS PROTOCOL // AUTH-01</div>

        <h1 className="login-title">U.L.T.R.O.N.</h1>
        <p className="login-subtitle">Personal Multimodal AI Assistant</p>

        <div className="login-divider" />

        <div className="login-body">
          <p className="login-instructions">
            AUTHENTICATION REQUIRED TO INITIALIZE NEURAL INTERFACE
          </p>

          {errorMsg && (
            <div className="login-error" role="alert">
              <span className="login-error-prefix">SECURITY ALERT:</span> {errorMsg}
            </div>
          )}

          <button
            type="button"
            className="login-btn-google"
            onClick={handleGoogleLogin}
            disabled={loading}
            aria-label="Continue with Google"
          >
            <svg
              className="login-google-icon"
              viewBox="0 0 24 24"
              width="20"
              height="20"
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
            <span>{loading ? "INITIALIZING SECURE LINK…" : "Continue with Google"}</span>
          </button>
        </div>

        <div className="login-footer">
          <span>SECURED VIA SUPABASE AUTH</span>
          <span>v1.0.0</span>
        </div>
      </div>
    </main>
  );
}
