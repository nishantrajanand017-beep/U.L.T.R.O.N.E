"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { KeyStatus } from "@/lib/db/userApiKeyStore";
import { subscribeToDeviceChannel } from "@/lib/realtime/deviceRealtime";
import { getApprovedAppsList, type AllowedAppConfig } from "@/lib/constants/appAllowlist";

interface SettingsModalProps {
  onClose: () => void;
}

interface ApiKeyStatusResponse {
  provider: "gemini";
  isConfigured: boolean;
  status: KeyStatus;
  keyHint: string | null;
  lastTestedAt: string | null;
  updatedAt: string | null;
  errorMessage?: string | null;
  hasEnvFallback?: boolean;
}

interface ElevenLabsStatusResponse {
  isConfigured: boolean;
  status: KeyStatus;
  voiceId: string;
  voiceName: string;
  modelId: string;
}

interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  connectionStatus: "connected" | "offline";
  createdAt: string;
  lastSeenAt: string;
  pairedAt: string;
}

interface PairingSessionInfo {
  code: string;
  expiresAt: number;
  expiresInSeconds: number;
}

const STATUS_LABELS: Record<KeyStatus, { label: string; className: string }> = {
  not_configured: {
    label: "NOT CONFIGURED",
    className: "status-not-configured",
  },
  configured: {
    label: "CONFIGURED",
    className: "status-configured",
  },
  valid: {
    label: "VALID",
    className: "status-valid",
  },
  invalid: {
    label: "INVALID",
    className: "status-invalid",
  },
  error: {
    label: "ERROR",
    className: "status-error",
  },
};

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<"api" | "devices" | "preferences">("api");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [statusData, setStatusData] = useState<ApiKeyStatusResponse | null>(null);
  const [elevenLabsData, setElevenLabsData] = useState<ElevenLabsStatusResponse | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [activePairing, setActivePairing] = useState<PairingSessionInfo | null>(null);
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false);
  const [unpairingDeviceId, setUnpairingDeviceId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isTestingElevenLabs, setIsTestingElevenLabs] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [elevenLabsFeedback, setElevenLabsFeedback] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [devicesFeedback, setDevicesFeedback] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [isLoadingDevices, setIsLoadingDevices] = useState(true);
  const [pingingDeviceId, setPingingDeviceId] = useState<string | null>(null);
  const [devicePingResults, setDevicePingResults] = useState<Record<string, { status: string; latencyMs?: number; message?: string }>>({});
  const [launchingDeviceId, setLaunchingDeviceId] = useState<string | null>(null);
  const [selectedAppPerDevice, setSelectedAppPerDevice] = useState<Record<string, string>>({});
  const [deviceLaunchResults, setDeviceLaunchResults] = useState<Record<string, { status: string; message: string }>>({});
  const pingStartTimesRef = useRef<Record<string, number>>({});
  const approvedApps = useRef<AllowedAppConfig[]>(getApprovedAppsList()).current;

  // Fetch current API key & ElevenLabs status
  const fetchStatus = useCallback(async () => {
    try {
      const [keyRes, elRes] = await Promise.all([
        fetch("/api/settings/api-key"),
        fetch("/api/settings/elevenlabs"),
      ]);

      if (keyRes.ok) {
        const data: ApiKeyStatusResponse = await keyRes.json();
        setStatusData(data);
      }

      if (elRes.ok) {
        const elData: ElevenLabsStatusResponse = await elRes.json();
        setElevenLabsData(elData);
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch authenticated user's paired devices
  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch("/api/devices");
      if (res.ok) {
        const data = await res.json();
        setDevices(data.devices || []);
        if (data.userId) {
          setCurrentUserId(data.userId);
        }
      }
    } catch (err) {
      console.error("Failed to load devices:", err);
    } finally {
      setIsLoadingDevices(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    void fetchDevices();
  }, [fetchDevices, fetchStatus]);

  // Real-time companion status link via Supabase Realtime channel
  useEffect(() => {
    if (!currentUserId || activeTab !== "devices") return;

    const sub = subscribeToDeviceChannel(currentUserId, {
      onStatusChange: (payload) => {
        setDevices((prev) =>
          prev.map((d) =>
            d.deviceId === payload.deviceId
              ? {
                  ...d,
                  connectionStatus: payload.status,
                  lastSeenAt: payload.timestamp || new Date().toISOString(),
                }
              : d
          )
        );
      },
      onHeartbeat: (payload) => {
        setDevices((prev) =>
          prev.map((d) =>
            d.deviceId === payload.deviceId
              ? {
                  ...d,
                  connectionStatus: "connected",
                  lastSeenAt:
                    typeof payload.timestamp === "number"
                      ? new Date(payload.timestamp).toISOString()
                      : payload.timestamp || new Date().toISOString(),
                }
              : d
          )
        );
      },
      onCommandResult: (payload) => {
        const start = pingStartTimesRef.current[payload.deviceId];
        const latencyMs = start ? Date.now() - start : undefined;
        const resObj = payload.result as Record<string, unknown> | undefined;
        const resType = String(resObj?.type || "");

        if (resType === "PONG") {
          setDevicePingResults((prev) => ({
            ...prev,
            [payload.deviceId]: {
              status: payload.status,
              latencyMs,
              message: `PONG received${latencyMs !== undefined ? ` in ${latencyMs}ms` : ""}`,
            },
          }));
          setPingingDeviceId((curr) => (curr === payload.deviceId ? null : curr));
        } else if (resType === "APP_LAUNCHED" || resType === "APP_NOT_INSTALLED" || resType === "APP_DISALLOWED" || resType === "APP_NOT_FOUND") {
          const appName = String(resObj?.appId || "application");
          const msg =
            resType === "APP_LAUNCHED"
              ? `App launch successful (${appName})`
              : resType === "APP_NOT_INSTALLED"
              ? `App not installed (${appName})`
              : payload.error || `App launch ${payload.status}`;

          setDeviceLaunchResults((prev) => ({
            ...prev,
            [payload.deviceId]: {
              status: payload.status,
              message: msg,
            },
          }));
          setLaunchingDeviceId((curr) => (curr === payload.deviceId ? null : curr));
        } else {
          // General command status fallback
          setDevicePingResults((prev) => ({
            ...prev,
            [payload.deviceId]: {
              status: payload.status,
              latencyMs,
              message: `Command ${payload.status}: ${payload.error || ""}`,
            },
          }));
          setPingingDeviceId((curr) => (curr === payload.deviceId ? null : curr));
          setLaunchingDeviceId((curr) => (curr === payload.deviceId ? null : curr));
        }
      },
    });

    return () => {
      sub.unsubscribe();
    };
  }, [currentUserId, activeTab]);

  // Periodic polling fallback for devices when Devices tab is open
  useEffect(() => {
    if (activeTab !== "devices") return;

    const interval = setInterval(() => {
      void fetchDevices();
    }, 5000);

    return () => clearInterval(interval);
  }, [activeTab, fetchDevices]);

  // Pairing code countdown timer
  useEffect(() => {
    if (!activePairing) {
      setCountdown(0);
      return;
    }

    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.floor((activePairing.expiresAt - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining <= 0) {
        setActivePairing(null);
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [activePairing]);

  // Generate pairing code
  const handleGeneratePairing = async () => {
    setIsGeneratingPairing(true);
    setDevicesFeedback(null);

    try {
      const res = await fetch("/api/devices/pairing/create", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        setActivePairing(data);
        setCountdown(data.expiresInSeconds || 300);
      } else {
        setDevicesFeedback({
          type: "error",
          message: data.error || "Failed to generate pairing code.",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error generating pairing session.";
      setDevicesFeedback({ type: "error", message: msg });
    } finally {
      setIsGeneratingPairing(false);
    }
  };

  // Unpair device
  const handleUnpairDevice = async (deviceId: string) => {
    setUnpairingDeviceId(deviceId);
    setDevicesFeedback(null);

    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
      });
      const data = await res.json();

      if (res.ok && data.success) {
        setDevices((prev) => prev.filter((d) => d.deviceId !== deviceId));
        setDevicesFeedback({
          type: "success",
          message: "Device successfully unpaired and credentials revoked.",
        });
      } else {
        setDevicesFeedback({
          type: "error",
          message: data.error || "Failed to unpair device.",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to unpair device.";
      setDevicesFeedback({ type: "error", message: msg });
    } finally {
      setUnpairingDeviceId(null);
    }
  };

  // Dispatch PING command to companion device
  const handlePingDevice = async (deviceId: string) => {
    setPingingDeviceId(deviceId);
    pingStartTimesRef.current[deviceId] = Date.now();
    setDevicePingResults((prev) => ({
      ...prev,
      [deviceId]: { status: "PENDING", message: "Dispatching PING..." },
    }));

    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandType: "PING", payload: {} }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDevicePingResults((prev) => ({
          ...prev,
          [deviceId]: { status: "FAILED", message: data.error || "Failed to dispatch PING" },
        }));
        setPingingDeviceId(null);
      } else {
        setDevicePingResults((prev) => ({
          ...prev,
          [deviceId]: { status: "PENDING", message: "PING sent, awaiting companion PONG..." },
        }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setDevicePingResults((prev) => ({
        ...prev,
        [deviceId]: { status: "FAILED", message: msg },
      }));
      setPingingDeviceId(null);
    }
  };

  // Dispatch OPEN_APP command to companion device
  const handleLaunchApp = async (deviceId: string) => {
    const appId = selectedAppPerDevice[deviceId] || "whatsapp";
    const appConfig = approvedApps.find((a) => a.appId === appId);
    const appDisplayName = appConfig ? appConfig.name : appId;

    setLaunchingDeviceId(deviceId);
    setDeviceLaunchResults((prev) => ({
      ...prev,
      [deviceId]: { status: "PENDING", message: `Launching ${appDisplayName}...` },
    }));

    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandType: "OPEN_APP",
          payload: { appId },
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setDeviceLaunchResults((prev) => ({
          ...prev,
          [deviceId]: {
            status: "FAILED",
            message: data.error || `Failed to launch ${appDisplayName}`,
          },
        }));
        setLaunchingDeviceId(null);
      } else {
        setDeviceLaunchResults((prev) => ({
          ...prev,
          [deviceId]: {
            status: "PENDING",
            message: `Launch command dispatched to ${appDisplayName}, awaiting device confirmation...`,
          },
        }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setDeviceLaunchResults((prev) => ({
        ...prev,
        [deviceId]: { status: "FAILED", message: msg },
      }));
      setLaunchingDeviceId(null);
    }
  };


  // Handle ElevenLabs Voice Connection Test
  const handleTestElevenLabs = async () => {
    setIsTestingElevenLabs(true);
    setElevenLabsFeedback(null);

    try {
      const res = await fetch("/api/settings/elevenlabs", { method: "POST" });
      const data = await res.json();

      if (res.ok && data.valid) {
        setElevenLabsFeedback({
          type: "success",
          message: data.message || "ElevenLabs connection verified! Voice output ready.",
        });
        setElevenLabsData((prev) => (prev ? { ...prev, status: "valid" } : null));
      } else {
        setElevenLabsFeedback({
          type: "error",
          message: data.message || "ElevenLabs verification failed.",
        });
        setElevenLabsData((prev) => (prev ? { ...prev, status: data.status || "invalid" } : null));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to test ElevenLabs connection.";
      setElevenLabsFeedback({ type: "error", message: msg });
    } finally {
      setIsTestingElevenLabs(false);
    }
  };


  // Handle Save / Update key
  const handleSaveKey = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setFeedback({ type: "error", message: "Please enter a valid API key." });
      return;
    }

    setIsSaving(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed, provider: "gemini" }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Error ${res.status}`);
      }

      setStatusData(data);
      setApiKeyInput("");
      setFeedback({
        type: "success",
        message: "API key securely encrypted and saved. Click 'TEST CONNECTION' to verify validity.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save API key.";
      setFeedback({ type: "error", message: msg });
    } finally {
      setIsSaving(false);
    }
  };

  // Handle Connection Test
  const handleTestKey = async () => {
    setIsTesting(true);
    setFeedback(null);

    try {
      const candidateKey = apiKeyInput.trim();
      const payload = candidateKey ? { candidateKey } : {};

      const res = await fetch("/api/settings/api-key/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setFeedback({
          type: "success",
          message: data.message || "Connection established successfully! Key is valid.",
        });
      } else {
        setFeedback({
          type: "error",
          message: data.message || "Key validation failed.",
        });
      }

      // Refresh status to reflect updated validity
      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection test failed.";
      setFeedback({ type: "error", message: msg });
    } finally {
      setIsTesting(false);
    }
  };

  // Handle Remove key
  const handleRemoveKey = async () => {
    if (!statusData?.isConfigured) return;

    if (!window.confirm("Are you sure you want to remove your stored Gemini API key?")) {
      return;
    }

    setIsRemoving(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/settings/api-key", {
        method: "DELETE",
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to remove key.");
      }

      setStatusData(data);
      setApiKeyInput("");
      setFeedback({
        type: "info",
        message: "API key removed. ULTRON will now use the development fallback key if present.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to remove API key.";
      setFeedback({ type: "error", message: msg });
    } finally {
      setIsRemoving(false);
    }
  };

  const currentStatus: KeyStatus = statusData?.status || "not_configured";
  const statusMeta = STATUS_LABELS[currentStatus] || STATUS_LABELS.not_configured;

  return (
    <div className="settings-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="region"
        aria-label="ULTRON Settings"
      >
        {/* Modal Header */}
        <div className="settings-header">
          <div className="settings-title">
            <span className="settings-indicator" />
            SYSTEM SETTINGS // CONFIGURATION
          </div>
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            aria-label="Close Settings"
          >
            ✕
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="settings-tabs">
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === "api" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("api");
              setFeedback(null);
            }}
          >
            API CONFIGURATION
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === "devices" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("devices");
              setFeedback(null);
              setDevicesFeedback(null);
            }}
          >
            DEVICES
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === "preferences" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("preferences");
              setFeedback(null);
            }}
          >
            PREFERENCES
          </button>
        </div>

        {/* Content Area */}
        <div className="settings-content">
          {activeTab === "api" && (
            <div className="settings-section">
              <div className="settings-notice-box">
                <span className="settings-notice-icon">🔒</span>
                <div>
                  <strong>PER-USER API ISOLATION:</strong> Provide your own Gemini API key to power your ULTRON requests.
                  Your key is securely encrypted at rest and never shared with other users, logs, or client scripts.
                </div>
              </div>

              {/* Provider Info */}
              <div className="settings-field-group">
                <label className="settings-label" htmlFor="provider-select">
                  AI PROVIDER
                </label>
                <div className="settings-provider-badge" id="provider-select">
                  <span className="provider-dot" />
                  GOOGLE GEMINI (GEMINI 3.6 FLASH)
                </div>
              </div>

              {/* Status Row */}
              <div className="settings-field-group">
                <label className="settings-label">CURRENT STATUS</label>
                <div className="settings-status-row">
                  <span className={`settings-status-badge ${statusMeta.className}`}>
                    <span className="status-pulse-dot" />
                    {statusMeta.label}
                  </span>

                  {statusData?.isConfigured && statusData.keyHint && (
                    <span className="settings-key-hint">
                      KEY: <code>{statusData.keyHint}</code>
                    </span>
                  )}

                  {!statusData?.isConfigured && statusData?.hasEnvFallback && (
                    <span className="settings-fallback-badge">
                      DEV FALLBACK ACTIVE
                    </span>
                  )}
                </div>

                {statusData?.lastTestedAt && (
                  <div className="settings-subtext">
                    Last tested: {new Date(statusData.lastTestedAt).toLocaleString()}
                  </div>
                )}
              </div>

              {/* API Key Input */}
              <form onSubmit={handleSaveKey} className="settings-field-group">
                <label className="settings-label" htmlFor="gemini-api-key-input">
                  {statusData?.isConfigured ? "UPDATE GEMINI API KEY" : "ENTER GEMINI API KEY"}
                </label>
                <div className="settings-input-wrap">
                  <input
                    id="gemini-api-key-input"
                    type={showKey ? "text" : "password"}
                    className="settings-input"
                    placeholder={
                      statusData?.isConfigured
                        ? "Enter new key to replace existing..."
                        : "Enter Gemini API key (e.g. AIzaSy...)"
                    }
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    autoComplete="off"
                    spellCheck="false"
                    disabled={isSaving || isTesting || isRemoving}
                  />
                  <button
                    type="button"
                    className="settings-toggle-show-btn"
                    onClick={() => setShowKey((prev) => !prev)}
                    title={showKey ? "Hide key" : "Show key"}
                  >
                    {showKey ? "HIDE" : "SHOW"}
                  </button>
                </div>
                <div className="settings-hint-text">
                  Get your free API key at{" "}
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="settings-link"
                  >
                    Google AI Studio
                  </a>
                  .
                </div>
              </form>

              {/* Feedback messages */}
              {feedback && (
                <div className={`settings-feedback-bar feedback-${feedback.type}`}>
                  {feedback.message}
                </div>
              )}

              {/* Action Buttons */}
              <div className="settings-action-row">
                <button
                  type="button"
                  className="hud-btn settings-btn settings-test-btn"
                  onClick={handleTestKey}
                  disabled={isTesting || isSaving || (!apiKeyInput.trim() && !statusData?.isConfigured)}
                >
                  {isTesting ? "TESTING..." : "TEST CONNECTION"}
                </button>

                <button
                  type="button"
                  className="hud-btn settings-btn settings-save-btn"
                  onClick={handleSaveKey}
                  disabled={isSaving || isTesting || !apiKeyInput.trim()}
                >
                  {isSaving ? "SAVING..." : statusData?.isConfigured ? "UPDATE KEY" : "SAVE KEY"}
                </button>

                {statusData?.isConfigured && (
                  <button
                    type="button"
                    className="hud-btn settings-btn settings-delete-btn"
                    onClick={handleRemoveKey}
                    disabled={isRemoving || isSaving || isTesting}
                  >
                    {isRemoving ? "REMOVING..." : "REMOVE KEY"}
                  </button>
                )}
              </div>

              {/* ElevenLabs Voice Synthesis Section */}
              <div
                style={{
                  margin: "24px 0 16px 0",
                  borderTop: "1px solid rgba(0, 240, 255, 0.2)",
                }}
              />

              <div className="settings-field-group">
                <label className="settings-label">VOICE SYNTHESIS (ELEVENLABS)</label>
                <div className="settings-provider-badge">
                  <span className="provider-dot" />
                  ELEVENLABS TTS // {elevenLabsData?.voiceName || "George"} ({elevenLabsData?.voiceId || "JBFqnCBsd6RMkjVDRZzb"})
                </div>
              </div>

              <div className="settings-field-group">
                <label className="settings-label">VOICE ENGINE STATUS</label>
                <div className="settings-status-row">
                  <span
                    className={`settings-status-badge ${
                      STATUS_LABELS[elevenLabsData?.status || "not_configured"].className
                    }`}
                  >
                    <span className="status-pulse-dot" />
                    {STATUS_LABELS[elevenLabsData?.status || "not_configured"].label}
                  </span>
                  <span className="settings-key-hint">
                    MODEL: <code>{elevenLabsData?.modelId || "eleven_flash_v2_5"}</code>
                  </span>
                </div>
                <div className="settings-subtext" style={{ marginTop: "6px" }}>
                  ElevenLabs API credentials are encrypted and managed in the server environment. Voice synthesis is invoked strictly during Voice Mode and never for text chat.
                </div>
              </div>

              {elevenLabsFeedback && (
                <div className={`settings-feedback-bar feedback-${elevenLabsFeedback.type}`}>
                  {elevenLabsFeedback.message}
                </div>
              )}

              <div className="settings-action-row" style={{ marginTop: "12px" }}>
                <button
                  type="button"
                  className="hud-btn settings-btn settings-test-btn"
                  onClick={handleTestElevenLabs}
                  disabled={isTestingElevenLabs}
                >
                  {isTestingElevenLabs ? "VERIFYING VOICE..." : "TEST VOICE CONNECTION"}
                </button>
              </div>
            </div>
          )}

          {activeTab === "devices" && (
            <div className="settings-section">
              <div className="settings-notice-box">
                <span className="settings-notice-icon">📱</span>
                <div>
                  <strong>ANDROID COMPANION LINK:</strong> Pair an Android mobile device to establish a secure authenticated connection with your ULTRON account. Single-use pairing sessions expire automatically in 5 minutes.
                </div>
              </div>

              {/* Action / Pair Request Row */}
              <div className="settings-field-group">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label className="settings-label">PAIRED ANDROID DEVICES ({devices.length})</label>
                  {!activePairing && (
                    <button
                      type="button"
                      className="hud-btn settings-btn"
                      style={{ height: "30px", fontSize: "10.5px", padding: "0 12px" }}
                      onClick={handleGeneratePairing}
                      disabled={isGeneratingPairing}
                    >
                      {isGeneratingPairing ? "GENERATING..." : "+ PAIR ANDROID DEVICE"}
                    </button>
                  )}
                </div>
              </div>

              {/* Active Pairing Session Box */}
              {activePairing && (
                <div className="pairing-box">
                  <div style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#00f0ff", fontWeight: "bold" }}>
                    PAIRING CODE (SINGLE USE)
                  </div>
                  <div className="pairing-code-display">
                    {activePairing.code}
                  </div>
                  <div className="pairing-timer-badge">
                    ⏳ EXPIRES IN: {Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, "0")}
                  </div>
                  <div style={{ fontSize: "11px", color: "#ffe6aa", maxWidth: "380px", lineHeight: 1.4 }}>
                    Open the <strong>ULTRON Android Companion</strong> app on your phone, enter this pairing code, and confirm to connect.
                  </div>
                  <button
                    type="button"
                    className="hud-btn settings-btn"
                    style={{
                      height: "28px",
                      fontSize: "10px",
                      marginTop: "4px",
                      padding: "0 10px",
                      borderColor: "rgba(255, 100, 100, 0.6)",
                      color: "#ff8888",
                    }}
                    onClick={() => setActivePairing(null)}
                  >
                    CANCEL PAIRING
                  </button>
                </div>
              )}

              {/* Feedback messages */}
              {devicesFeedback && (
                <div className={`settings-feedback-bar feedback-${devicesFeedback.type}`}>
                  {devicesFeedback.message}
                </div>
              )}

              {/* Devices List */}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {isLoadingDevices ? (
                  <div
                    className="settings-subtext"
                    style={{
                      padding: "16px",
                      textAlign: "center",
                      background: "rgba(20, 10, 0, 0.4)",
                      borderRadius: "4px",
                      border: "1px dashed rgba(255, 170, 48, 0.25)",
                    }}
                  >
                    Loading paired Android companion devices...
                  </div>
                ) : devices.length === 0 ? (
                  <div
                    className="settings-subtext"
                    style={{
                      padding: "16px",
                      textAlign: "center",
                      background: "rgba(20, 10, 0, 0.4)",
                      borderRadius: "4px",
                      border: "1px dashed rgba(255, 170, 48, 0.25)",
                    }}
                  >
                    No Android devices paired yet. Click <strong>+ PAIR ANDROID DEVICE</strong> to link your phone.
                  </div>
                ) : (
                  devices.map((dev) => (
                    <div key={dev.deviceId} className="device-card">
                      <div className="device-info-col">
                        <div className="device-name-row">
                          <span className="device-name">{dev.deviceName}</span>
                          <span
                            className={`settings-status-badge ${
                              dev.connectionStatus === "connected"
                                ? "status-valid"
                                : "status-not-configured"
                            }`}
                            style={{ padding: "2px 8px", fontSize: "10px" }}
                          >
                            <span className="status-pulse-dot" />
                            {dev.connectionStatus === "connected" ? "CONNECTED" : "OFFLINE"}
                          </span>
                        </div>
                        <div className="device-meta-row">
                          <span>
                            Platform: <strong>{dev.platform} v{dev.appVersion}</strong>
                          </span>
                          <span>
                            ID: <code>{dev.deviceId.slice(0, 12)}...</code>
                          </span>
                          <span>
                            Last Seen:{" "}
                            <strong>
                              {new Date(dev.lastSeenAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                              })}
                            </strong>
                          </span>
                        </div>

                        {/* OPEN_APP Selector and Action */}
                        <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "6px", flexWrap: "wrap" }}>
                          <span style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.6)", letterSpacing: "0.05em" }}>
                            OPEN APP:
                          </span>
                          <select
                            value={selectedAppPerDevice[dev.deviceId] || "whatsapp"}
                            onChange={(e) =>
                              setSelectedAppPerDevice((prev) => ({
                                ...prev,
                                [dev.deviceId]: e.target.value,
                              }))
                            }
                            disabled={dev.connectionStatus !== "connected" || launchingDeviceId === dev.deviceId}
                            style={{
                              background: "rgba(0, 20, 30, 0.8)",
                              border: "1px solid rgba(0, 240, 255, 0.3)",
                              color: "#00f0ff",
                              fontSize: "10px",
                              padding: "2px 6px",
                              borderRadius: "3px",
                              outline: "none",
                              cursor: dev.connectionStatus !== "connected" ? "not-allowed" : "pointer",
                            }}
                          >
                            {approvedApps.map((app) => (
                              <option key={app.appId} value={app.appId} style={{ background: "#0a1015", color: "#e0f7ff" }}>
                                {app.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="hud-btn settings-btn"
                            style={{
                              height: "24px",
                              fontSize: "9.5px",
                              padding: "0 8px",
                              borderColor: "rgba(0, 240, 255, 0.5)",
                              color: "#00f0ff",
                            }}
                            onClick={() => handleLaunchApp(dev.deviceId)}
                            disabled={launchingDeviceId === dev.deviceId || dev.connectionStatus !== "connected"}
                            title={dev.connectionStatus !== "connected" ? "Device is offline" : "Launch application on device"}
                          >
                            {launchingDeviceId === dev.deviceId ? "LAUNCHING..." : "LAUNCH"}
                          </button>
                        </div>

                        {/* Live Feedback Messages */}
                        {deviceLaunchResults[dev.deviceId] && (
                          <div
                            style={{
                              fontSize: "11px",
                              marginTop: "4px",
                              color:
                                deviceLaunchResults[dev.deviceId].status === "SUCCESS"
                                  ? "#00ffcc"
                                  : deviceLaunchResults[dev.deviceId].status === "FAILED"
                                  ? "#ff4d4d"
                                  : "#ffaa30",
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            <span>📲</span>
                            <span>{deviceLaunchResults[dev.deviceId].message}</span>
                          </div>
                        )}

                        {devicePingResults[dev.deviceId] && (
                          <div
                            style={{
                              fontSize: "11px",
                              marginTop: "4px",
                              color:
                                devicePingResults[dev.deviceId].status === "SUCCESS"
                                  ? "#00ffcc"
                                  : devicePingResults[dev.deviceId].status === "FAILED"
                                  ? "#ff4d4d"
                                  : "#ffaa30",
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            <span>⚡</span>
                            <span>{devicePingResults[dev.deviceId].message}</span>
                          </div>
                        )}
                      </div>

                      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        <button
                          type="button"
                          className="hud-btn settings-btn"
                          style={{
                            height: "32px",
                            fontSize: "10px",
                            padding: "0 12px",
                            borderColor: "rgba(0, 255, 200, 0.4)",
                            color: "#00ffcc",
                          }}
                          onClick={() => handlePingDevice(dev.deviceId)}
                          disabled={pingingDeviceId === dev.deviceId || dev.connectionStatus !== "connected"}
                          title={dev.connectionStatus !== "connected" ? "Device is offline" : "Send PING command"}
                        >
                          {pingingDeviceId === dev.deviceId ? "PINGING..." : "PING"}
                        </button>
                        <button
                          type="button"
                          className="hud-btn settings-btn settings-delete-btn"
                          style={{ height: "32px", fontSize: "10px", padding: "0 10px" }}
                          onClick={() => handleUnpairDevice(dev.deviceId)}
                          disabled={unpairingDeviceId === dev.deviceId}
                        >
                          {unpairingDeviceId === dev.deviceId ? "UNPAIRING..." : "UNPAIR"}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}


          {activeTab === "preferences" && (
            <div className="settings-section">
              <div className="settings-field-group">
                <label className="settings-label">INTERFACE MODE</label>
                <div className="settings-subtext">
                  Iron Man Holographic HUD with WebGL Post-processing, Three.js shaders, and MediaPipe gestures.
                </div>
              </div>

              <div className="settings-field-group">
                <label className="settings-label">KEYBOARD SHORTCUTS</label>
                <div className="settings-shortcuts-list">
                  <div><span className="key">S</span> Toggle Settings Modal</div>
                  <div><span className="key">C</span> Toggle Gemini Chat Panel</div>
                  <div><span className="key">V</span> Toggle Voice Interaction Mode</div>
                  <div><span className="key">G</span> Toggle Hand Tracking Gestures</div>
                  <div><span className="key">R</span> Reset Orb Camera View</div>
                  <div><span className="key">+ / −</span> Zoom In / Out</div>
                </div>
              </div>

              <div className="settings-field-group">
                <label className="settings-label">SESSION STATUS</label>
                <div className="settings-subtext">
                  Isolated session active. All user settings are stored securely server-side.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
