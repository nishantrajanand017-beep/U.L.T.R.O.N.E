"use client";

import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

export interface DeviceStatusPayload {
  deviceId: string;
  status: "connected" | "offline";
  appVersion?: string;
  timestamp?: string;
}

export interface DeviceHeartbeatPayload {
  deviceId: string;
  timestamp?: string | number;
}

export interface DeviceEventPayload {
  deviceId: string;
  eventName: string;
  data?: unknown;
}

export type CommandType = "PING" | "OPEN_APP";

export interface OpenAppPayload {
  appId: string;
  packageName?: string;
}

export type CommandStatus =
  | "PENDING"
  | "RECEIVED"
  | "EXECUTING"
  | "SUCCESS"
  | "FAILED"
  | "EXPIRED"
  | "DUPLICATE";

export interface DeviceCommand<T = Record<string, unknown>> {
  commandId: string;
  targetDeviceId: string;
  commandType: CommandType;
  createdAt: string;
  expiresAt: number;
  payload: T;
  source: string;
}

export interface DeviceCommandResult<T = unknown> {
  commandId: string;
  deviceId: string;
  status: CommandStatus;
  result?: T;
  error?: string;
  completedAt: string;
}

export interface DeviceRealtimeCallbacks {
  onStatusChange?: (payload: DeviceStatusPayload) => void;
  onHeartbeat?: (payload: DeviceHeartbeatPayload) => void;
  onEvent?: (payload: DeviceEventPayload) => void;
  onCommandResult?: (payload: DeviceCommandResult) => void;
  onConnectionChange?: (status: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR") => void;
}

export interface DeviceRealtimeSubscription {
  channel: RealtimeChannel | null;
  sendCommand: (deviceId: string, action: string, params?: Record<string, unknown>) => Promise<boolean>;
  sendDeviceCommand: (command: DeviceCommand) => Promise<boolean>;
  sendPing: () => Promise<boolean>;
  unsubscribe: () => void;
}

/**
 * Connects the web client to the user-scoped Supabase Realtime channel (ultron:devices:<userId>).
 * Receives companion device events and allows dispatching commands without exposing device secrets.
 */
export function subscribeToDeviceChannel(
  userId: string,
  callbacks: DeviceRealtimeCallbacks = {}
): DeviceRealtimeSubscription {
  if (typeof window === "undefined" || !userId) {
    return {
      channel: null,
      sendCommand: async () => false,
      sendDeviceCommand: async () => false,
      sendPing: async () => false,
      unsubscribe: () => {},
    };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();

  if (!supabaseUrl || !supabaseKey || supabaseUrl.includes("your_supabase")) {
    console.warn(
      "[ULTRON Realtime] Supabase Realtime not configured. Falling back to REST polling."
    );
    return {
      channel: null,
      sendCommand: async () => false,
      sendDeviceCommand: async () => false,
      sendPing: async () => false,
      unsubscribe: () => {},
    };
  }

  const supabase = createClient();
  const channelName = `ultron:devices:${userId}`;

  const channel: RealtimeChannel = supabase.channel(channelName, {
    config: {
      broadcast: {
        ack: true,
        self: false,
      },
    },
  });

  channel
    .on("broadcast", { event: "device:status" }, (event) => {
      if (callbacks.onStatusChange && event.payload) {
        callbacks.onStatusChange(event.payload as DeviceStatusPayload);
      }
    })
    .on("broadcast", { event: "device:heartbeat" }, (event) => {
      if (callbacks.onHeartbeat && event.payload) {
        callbacks.onHeartbeat(event.payload as DeviceHeartbeatPayload);
      }
    })
    .on("broadcast", { event: "device:event" }, (event) => {
      if (callbacks.onEvent && event.payload) {
        callbacks.onEvent(event.payload as DeviceEventPayload);
      }
    })
    .on("broadcast", { event: "device_command_result" }, (event) => {
      if (callbacks.onCommandResult && event.payload) {
        callbacks.onCommandResult(event.payload as DeviceCommandResult);
      }
    })
    .subscribe((status) => {
      if (callbacks.onConnectionChange) {
        callbacks.onConnectionChange(status as "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR");
      }
    });

  const sendCommand = async (
    deviceId: string,
    action: string,
    params: Record<string, unknown> = {}
  ): Promise<boolean> => {
    try {
      const resp = await channel.send({
        type: "broadcast",
        event: "command",
        payload: {
          commandId: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          targetDeviceId: deviceId,
          action,
          params,
          timestamp: new Date().toISOString(),
        },
      });
      return resp === "ok";
    } catch (err) {
      console.error("[ULTRON Realtime] Failed to send command:", err);
      return false;
    }
  };

  const sendDeviceCommand = async (
    command: DeviceCommand
  ): Promise<boolean> => {
    try {
      const resp = await channel.send({
        type: "broadcast",
        event: "device_command",
        payload: command,
      });
      return resp === "ok";
    } catch (err) {
      console.error("[ULTRON Realtime] Failed to send device command:", err);
      return false;
    }
  };

  const sendPing = async (): Promise<boolean> => {
    try {
      const resp = await channel.send({
        type: "broadcast",
        event: "ping",
        payload: {
          pingId: `png_${Date.now()}`,
          timestamp: new Date().toISOString(),
        },
      });
      return resp === "ok";
    } catch {
      return false;
    }
  };

  const unsubscribe = () => {
    try {
      void supabase.removeChannel(channel);
    } catch (err) {
      console.warn("[ULTRON Realtime] Error removing channel:", err);
    }
  };

  return {
    channel,
    sendCommand,
    sendDeviceCommand,
    sendPing,
    unsubscribe,
  };
}
