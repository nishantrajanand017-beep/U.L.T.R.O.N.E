"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import ChatPanel from "@/components/ChatPanel";
import VoiceMode from "@/components/VoiceMode";
import SettingsModal from "@/components/SettingsModal";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";

interface UserProfile {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  isGuest?: boolean;
}

type CameraState = "off" | "starting" | "on" | "error";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

export default function JarvisOrb({
  initialUser,
}: {
  initialUser?: UserProfile;
} = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [chatOpen, setChatOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(initialUser || null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  // Listen to Supabase auth state
  useEffect(() => {
    if (!isSupabaseConfigured()) {
      return;
    }

    try {
      const supabase = createClient();

      const extractProfile = (rawUser: {
        id: string;
        email?: string;
        is_anonymous?: boolean;
        app_metadata?: Record<string, unknown>;
        user_metadata?: Record<string, unknown>;
      }): UserProfile => {
        const isGuest = Boolean(
          rawUser.is_anonymous ||
          rawUser.app_metadata?.provider === "anonymous" ||
          rawUser.id.startsWith("guest_")
        );
        const metadata = rawUser.user_metadata || {};
        const name = isGuest
          ? "GUEST OPERATOR"
          : (typeof metadata.full_name === "string" && metadata.full_name) ||
            (typeof metadata.name === "string" && metadata.name) ||
            rawUser.email?.split("@")[0] ||
            "OPERATOR";
        const email = rawUser.email || (isGuest ? "guest@ultron.internal" : "");
        const avatarUrl =
          (typeof metadata.avatar_url === "string" && metadata.avatar_url) ||
          (typeof metadata.picture === "string" && metadata.picture) ||
          undefined;
        return { id: rawUser.id, name, email, avatarUrl, isGuest };
      };

      // Initial user check
      supabase.auth.getUser().then(({ data: { user }, error }) => {
        if (user && !error) {
          setUser(extractProfile(user));
        } else if (!initialUser) {
          setUser(null);
        }
      });

      // Subscription to auth changes
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user) {
          setUser(extractProfile(session.user));
        } else if (!initialUser) {
          setUser(null);
        }
      });

      return () => {
        subscription.unsubscribe();
      };
    } catch (err) {
      console.warn("[JarvisOrb] Supabase auth check error:", err);
    }
  }, [initialUser]);

  // Close account menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    if (accountMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [accountMenuOpen]);

  const handleSignOut = useCallback(async () => {
    try {
      if (isSupabaseConfigured()) {
        const supabase = createClient();
        await supabase.auth.signOut();
      }
      try {
        await fetch("/api/auth/session", { method: "DELETE" });
      } catch {
        // Fallback
      }
    } catch (err) {
      console.warn("[JarvisOrb] Sign out error:", err);
    } finally {
      setUser(null);
      setAccountMenuOpen(false);
      window.location.href = "/login";
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if user is typing in chat input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "c":
        case "C":
          setChatOpen((prev) => !prev);
          break;
        case "v":
        case "V":
          setVoiceOpen((prev) => !prev);
          break;
        case "s":
        case "S":
          setSettingsOpen((prev) => !prev);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures]);

  const cameraOn = camera === "on";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">U.L.T.R.O.N.</div>

      {/* Top-Right HUD Account Area */}
      <div ref={accountRef} className="hud-account-container">
        {user ? (
          <div className="hud-account-bar">
            <button
              type="button"
              id="hud-account-pill-btn"
              className="hud-account-pill"
              onClick={() => setAccountMenuOpen((prev) => !prev)}
              aria-expanded={accountMenuOpen}
              aria-label={`Account details for ${user.name}`}
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="hud-account-avatar"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="hud-account-avatar-placeholder">
                  {user.name.charAt(0).toUpperCase()}
                </div>
              )}
              <span className="hud-account-username">{user.name.toUpperCase()}</span>
              {user.isGuest && <span className="hud-guest-tag">GUEST</span>}
              <span
                className={`hud-account-status-dot${user.isGuest ? " guest" : ""}`}
                title={user.isGuest ? "Guest Session (Restricted)" : "Authenticated"}
              />
              <span className={`hud-account-chevron${accountMenuOpen ? " open" : ""}`}>
                ▼
              </span>
            </button>

            <button
              type="button"
              id="hud-direct-logout-btn"
              className="hud-logout-btn"
              onClick={handleSignOut}
              title="Sign out of ULTRON"
              aria-label="Logout of ULTRON"
            >
              LOGOUT
            </button>

            {accountMenuOpen && (
              <div
                className="hud-account-popover"
                role="dialog"
                aria-label="User account details"
              >
                <div className="hud-popover-header">
                  {user.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt=""
                      className="hud-popover-avatar"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="hud-popover-avatar-placeholder">
                      {user.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="hud-popover-user-info">
                    <div className="hud-popover-name">{user.name}</div>
                    <div className="hud-popover-email">{user.email}</div>
                  </div>
                </div>

                <div className="hud-popover-divider" />

                <div className="hud-popover-status-row">
                  <span>AUTH STATUS</span>
                  <span className={`hud-popover-badge${user.isGuest ? " guest" : ""}`}>
                    {user.isGuest ? "GUEST (RESTRICTED)" : "AUTHENTICATED"}
                  </span>
                </div>

                {user.isGuest && (
                  <>
                    <div className="hud-popover-guest-notice">
                      EPHEMERAL SESSION // DATA &amp; SETTINGS LOCKED
                    </div>
                    <a
                      href="/register"
                      className="hud-popover-register-btn"
                      aria-label="Create a permanent account"
                    >
                      UPGRADE // CREATE ACCOUNT
                    </a>
                  </>
                )}

                <button
                  type="button"
                  id="hud-btn-signout"
                  className="hud-account-signout-btn"
                  onClick={handleSignOut}
                  aria-label="Sign out of ULTRON"
                >
                  SIGN OUT
                </button>
              </div>
            )}
          </div>
        ) : (
          <a
            href="/login"
            id="hud-btn-signin"
            className="hud-signin-btn"
            aria-label="Sign in to ULTRON"
          >
            <span>SIGN IN</span>
          </a>
        )}
      </div>

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">S</span> settings&nbsp;&nbsp;
            <span className="key">V</span> voice&nbsp;&nbsp;
            <span className="key">C</span> chat&nbsp;&nbsp;
            <span className="key">G</span> hand gestures&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/−</span> zoom
          </div>
        )}
      </div>

      {chatOpen && (
        <ChatPanel
          isGuest={Boolean(user?.isGuest)}
          onClose={() => setChatOpen(false)}
        />
      )}
      {voiceOpen && (
        <VoiceMode
          onClose={() => {
            sceneRef.current?.setVoiceState("IDLE");
            sceneRef.current?.setAudioLevel(0);
            setVoiceOpen(false);
          }}
          onStateChange={(s) => sceneRef.current?.setVoiceState(s)}
          onAudioLevel={(l) => sceneRef.current?.setAudioLevel(l)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          isGuest={Boolean(user?.isGuest)}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
              : "SHOW HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}

        <div className="hud-row">
          <button
            type="button"
            id="hud-btn-settings"
            className="hud-btn"
            aria-pressed={settingsOpen}
            onClick={() => setSettingsOpen((prev) => !prev)}
          >
            {settingsOpen ? "CLOSE SETTINGS" : "SETTINGS"}
          </button>
          <button
            type="button"
            id="hud-btn-voice"
            className="hud-btn"
            aria-pressed={voiceOpen}
            onClick={() => setVoiceOpen((prev) => !prev)}
          >
            {voiceOpen ? "EXIT VOICE" : "VOICE"}
          </button>
          <button
            type="button"
            id="hud-btn-chat"
            className="hud-btn"
            aria-pressed={chatOpen}
            onClick={() => setChatOpen((prev) => !prev)}
          >
            {chatOpen ? "CLOSE CHAT" : "CHAT"}
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            onClick={() => sceneRef.current?.zoomIn()}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="hud-btn"
            onClick={() => sceneRef.current?.zoomOut()}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="hud-btn"
            onClick={() => sceneRef.current?.resetView()}
          >
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
