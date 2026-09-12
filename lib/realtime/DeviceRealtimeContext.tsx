"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  subscribeToDeviceChannel,
  type DeviceRealtimeSubscription,
  type DeviceAppCatalogEntry,
} from "./deviceRealtime";

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  connectionStatus: "connected" | "offline";
  createdAt: string;
  lastSeenAt: string;
  pairedAt: string;
}

export interface PingResult {
  status: string;
  latencyMs?: number;
  message?: string;
}

export interface LaunchResult {
  status: string;
  message: string;
}

interface DeviceRealtimeContextValue {
  devices: DeviceInfo[];
  currentUserId: string | null;
  isLoadingDevices: boolean;
  realtimeStatus: "SUBSCRIBED" | "TIMED_OUT" | "CONNECTING" | "OFFLINE" | "CHANNEL_ERROR" | "CLOSED";
  appCatalogs: Record<string, DeviceAppCatalogEntry[]>;
  pingResults: Record<string, PingResult>;
  launchResults: Record<string, LaunchResult>;
  pingingDeviceId: string | null;
  launchingDeviceId: string | null;
  fetchDevices: () => Promise<void>;
  pingDevice: (deviceId: string) => Promise<void>;
  launchApp: (deviceId: string, appId: string, appDisplayName?: string) => Promise<void>;
  refreshAppCatalog: (deviceId: string) => Promise<void>;
  unpairDevice: (deviceId: string) => Promise<{ success: boolean; error?: string }>;
  setDevices: React.Dispatch<React.SetStateAction<DeviceInfo[]>>;
}

const DeviceRealtimeContext = createContext<DeviceRealtimeContextValue | null>(null);

export function DeviceRealtimeProvider({ children }: { children: ReactNode }) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [isLoadingDevices, setIsLoadingDevices] = useState(true);
  const [realtimeStatus, setRealtimeStatus] = useState<
    "SUBSCRIBED" | "TIMED_OUT" | "CONNECTING" | "OFFLINE" | "CHANNEL_ERROR" | "CLOSED"
  >("OFFLINE");

  const [appCatalogs, setAppCatalogs] = useState<Record<string, DeviceAppCatalogEntry[]>>({});
  const [pingResults, setPingResults] = useState<Record<string, PingResult>>({});
  const [launchResults, setLaunchResults] = useState<Record<string, LaunchResult>>({});
  const [pingingDeviceId, setPingingDeviceId] = useState<string | null>(null);
  const [launchingDeviceId, setLaunchingDeviceId] = useState<string | null>(null);

  const pingStartTimesRef = useRef<Record<string, number>>({});
  const launchedAppNamesRef = useRef<Record<string, string>>({});
  const subRef = useRef<DeviceRealtimeSubscription | null>(null);

  // Fetch device list and user ID
  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch("/api/devices");
      if (res.ok) {
        const data = await res.json();
        setDevices(data.devices || []);
        if (data.userId) {
          setCurrentUserId(data.userId);
        }

        // Also fetch known catalogs for each device
        const deviceList: DeviceInfo[] = data.devices || [];
        for (const dev of deviceList) {
          try {
            const catRes = await fetch(`/api/devices/${encodeURIComponent(dev.deviceId)}/catalog`);
            if (catRes.ok) {
              const catData = await catRes.json();
              if (Array.isArray(catData.apps) && catData.apps.length > 0) {
                setAppCatalogs((prev) => ({
                  ...prev,
                  [dev.deviceId]: catData.apps,
                }));
              }
            }
          } catch {
            // Ignore catalog prefetch failure
          }
        }
      }
    } catch (err) {
      console.error("[DeviceRealtimeProvider] Failed to load devices:", err);
    } finally {
      setIsLoadingDevices(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);

  // Periodic device list polling every 30s as a secondary sync
  useEffect(() => {
    const interval = setInterval(() => {
      void fetchDevices();
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchDevices]);

  // Global persistent Realtime subscription
  useEffect(() => {
    if (!currentUserId) return;

    setRealtimeStatus("CONNECTING");

    const sub = subscribeToDeviceChannel(currentUserId, {
      onConnectionChange: (status) => {
        setRealtimeStatus(status);
      },
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
      onAppCatalog: (payload) => {
        if (payload.deviceId && Array.isArray(payload.apps)) {
          setAppCatalogs((prev) => ({
            ...prev,
            [payload.deviceId]: payload.apps,
          }));

          // Sync received catalog with server storage for persistence
          void fetch(`/api/devices/${encodeURIComponent(payload.deviceId)}/catalog`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apps: payload.apps }),
          }).catch((err) => {
            console.warn("[DeviceRealtimeProvider] Could not sync catalog to server:", err);
          });
        }
      },
      onCommandResult: (payload) => {
        const start = pingStartTimesRef.current[payload.deviceId];
        const latencyMs = start ? Date.now() - start : undefined;
        const resObj = payload.result as Record<string, unknown> | undefined;
        const resType = String(resObj?.type || "");
        const cmdType = payload.commandType;

        const isAppCommand =
          cmdType === "OPEN_APP" ||
          resType.startsWith("APP_") ||
          (launchingDeviceId === payload.deviceId && cmdType !== "PING" && resType !== "PONG");

        if (isAppCommand) {
          const appName = String(
            resObj?.appId || launchedAppNamesRef.current[payload.deviceId] || "application"
          );
          const msg =
            resType === "APP_LAUNCHED"
              ? `App launch successful (${appName})`
              : resType === "APP_NOT_INSTALLED"
              ? `App not installed (${appName})`
              : resType === "APP_DISALLOWED"
              ? `App not allowed (${appName})`
              : payload.error
              ? `App launch failed: ${payload.error}`
              : `App launch ${payload.status}`;

          setLaunchResults((prev) => ({
            ...prev,
            [payload.deviceId]: {
              status: payload.status,
              message: msg,
            },
          }));
          setLaunchingDeviceId((curr) => (curr === payload.deviceId ? null : curr));
        } else {
          // PING result
          const msg =
            resType === "PONG"
              ? `PONG received${latencyMs !== undefined ? ` in ${latencyMs}ms` : ""}`
              : payload.error
              ? `PING failed: ${payload.error}`
              : `Command ${payload.status}: ${payload.error || ""}`;

          setPingResults((prev) => ({
            ...prev,
            [payload.deviceId]: {
              status: payload.status,
              latencyMs,
              message: msg,
            },
          }));
          setPingingDeviceId((curr) => (curr === payload.deviceId ? null : curr));
        }
      },
    });

    subRef.current = sub;

    return () => {
      sub.unsubscribe();
      subRef.current = null;
    };
  }, [currentUserId, launchingDeviceId]);

  // Dispatch PING command
  const pingDevice = useCallback(async (deviceId: string) => {
    setPingingDeviceId(deviceId);
    pingStartTimesRef.current[deviceId] = Date.now();
    setPingResults((prev) => ({
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
        setPingResults((prev) => ({
          ...prev,
          [deviceId]: { status: "FAILED", message: data.error || "Failed to dispatch PING" },
        }));
        setPingingDeviceId(null);
      } else {
        setPingResults((prev) => ({
          ...prev,
          [deviceId]: { status: "PENDING", message: "PING sent, awaiting companion PONG..." },
        }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setPingResults((prev) => ({
        ...prev,
        [deviceId]: { status: "FAILED", message: msg },
      }));
      setPingingDeviceId(null);
    }
  }, []);

  // Dispatch OPEN_APP command
  const launchApp = useCallback(
    async (deviceId: string, appId: string, appDisplayName?: string) => {
      const displayName = appDisplayName || appId;
      launchedAppNamesRef.current[deviceId] = displayName;
      setLaunchingDeviceId(deviceId);
      setLaunchResults((prev) => ({
        ...prev,
        [deviceId]: { status: "PENDING", message: `Launching ${displayName}...` },
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
          setLaunchResults((prev) => ({
            ...prev,
            [deviceId]: {
              status: "FAILED",
              message: data.error || `Failed to launch ${displayName}`,
            },
          }));
          setLaunchingDeviceId(null);
        } else {
          setLaunchResults((prev) => ({
            ...prev,
            [deviceId]: {
              status: "PENDING",
              message: `Launch command dispatched to ${displayName}, awaiting device confirmation...`,
            },
          }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        setLaunchResults((prev) => ({
          ...prev,
          [deviceId]: { status: "FAILED", message: msg },
        }));
        setLaunchingDeviceId(null);
      }
    },
    []
  );

  // Request refreshed app catalog from companion device
  const refreshAppCatalog = useCallback(async (deviceId: string) => {
    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/catalog`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.apps)) {
          setAppCatalogs((prev) => ({
            ...prev,
            [deviceId]: data.apps,
          }));
        }
      }
    } catch (err) {
      console.warn("[DeviceRealtimeProvider] Failed to fetch catalog:", err);
    }
  }, []);

  // Unpair a device
  const unpairDevice = useCallback(
    async (deviceId: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
          method: "DELETE",
        });
        const data = await res.json();
        if (res.ok && data.success) {
          setDevices((prev) => prev.filter((d) => d.deviceId !== deviceId));
          setAppCatalogs((prev) => {
            const next = { ...prev };
            delete next[deviceId];
            return next;
          });
          return { success: true };
        }
        return { success: false, error: data.error || "Failed to unpair device." };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Failed to unpair device.",
        };
      }
    },
    []
  );

  return (
    <DeviceRealtimeContext.Provider
      value={{
        devices,
        currentUserId,
        isLoadingDevices,
        realtimeStatus,
        appCatalogs,
        pingResults,
        launchResults,
        pingingDeviceId,
        launchingDeviceId,
        fetchDevices,
        pingDevice,
        launchApp,
        refreshAppCatalog,
        unpairDevice,
        setDevices,
      }}
    >
      {children}
    </DeviceRealtimeContext.Provider>
  );
}

export function useDeviceRealtime(): DeviceRealtimeContextValue {
  const ctx = useContext(DeviceRealtimeContext);
  if (!ctx) {
    throw new Error("useDeviceRealtime must be used within a <DeviceRealtimeProvider>");
  }
  return ctx;
}
