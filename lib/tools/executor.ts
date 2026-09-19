/**
 * lib/tools/executor.ts
 *
 * Secure server-side tool dispatcher for ULTRON.
 * Enforces:
 * 1. Registry whitelist (unknown tools fail closed)
 * 2. Caller authentication and tenant isolation
 * 3. Device ownership verification
 * 4. Application allowlist resolution (no client/model-supplied package names)
 * 5. Mandatory confirmation for physical device actions (open_device_app)
 * 6. Zero shell or code execution
 */

import crypto from "node:crypto";
import type {
  ToolCall,
  ToolExecutionContext,
  ToolResult,
  ToolResultSuccess,
  ToolResultError,
  PendingActionDetails,
} from "./types";
import { isToolRegistered } from "./registry";
import { listUserDevices, getSupabase } from "../db/deviceStore";
import { resolveApprovedApp } from "../constants/appAllowlist";
import { findInDeviceCatalog } from "../db/deviceCatalogStore";
import {
  createPendingConfirmation,
  type PendingConfirmation,
} from "./confirmationStore";
import type { DeviceCommand } from "../realtime/deviceRealtime";

/**
 * Dispatches a tool call requested by Qwen.
 */
export async function executeTool(
  toolCall: ToolCall,
  context: ToolExecutionContext
): Promise<ToolResult> {
  // 1. Authenticate caller
  if (!context || !context.userId || typeof context.userId !== "string" || !context.userId.trim()) {
    return {
      status: "error",
      error: "Authentication required: Missing or invalid user identity in execution context.",
    };
  }

  const { name } = toolCall.function;

  // 1b. Restrict guest/anonymous callers from physical device or private controls
  if (context.isAnonymous && name !== "get_system_time") {
    return {
      status: "error",
      error: "Permission denied: Guest operators cannot interact with physical devices or private controls.",
    };
  }

  // 2. Validate tool exists in registry
  if (!isToolRegistered(name)) {
    return {
      status: "error",
      error: `Tool execution denied: Unknown or unregistered tool '${name}'.`,
    };
  }

  // 3. Parse and validate arguments JSON
  let args: Record<string, unknown> = {};
  try {
    const rawArgs = toolCall.function.arguments;
    if (rawArgs && rawArgs.trim().length > 0) {
      args = JSON.parse(rawArgs);
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return {
          status: "error",
          error: "Malformed tool arguments: Arguments must be a JSON object.",
        };
      }
    }
  } catch (err) {
    return {
      status: "error",
      error: `Malformed JSON in tool arguments: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Route to specific tool implementation
  switch (name) {
    case "get_system_time":
      return handleGetSystemTime();

    case "get_device_status":
      return handleGetDeviceStatus(args, context.userId);

    case "open_device_app":
      return handleOpenDeviceApp(args, context.userId);

    default:
      return {
        status: "error",
        error: `Tool '${name}' is not supported by executor.`,
      };
  }
}

/**
 * Tool: get_system_time
 * Safe, read-only server time inquiry.
 */
function handleGetSystemTime(): ToolResultSuccess {
  const now = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return {
    status: "success",
    output: {
      iso: now.toISOString(),
      localeFormatted: now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "medium" }),
      time: now.toLocaleTimeString("en-US", { hour12: true }),
      date: now.toLocaleDateString("en-US"),
      dayOfWeek: days[now.getDay()],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      unixTimestampSeconds: Math.floor(now.getTime() / 1000),
    },
  };
}

/**
 * Tool: get_device_status
 * Safe, read-only device inquiry. Enforces ownership verification.
 */
async function handleGetDeviceStatus(
  args: Record<string, unknown>,
  userId: string
): Promise<ToolResultSuccess | ToolResultError> {
  const rawDeviceId = args.deviceId;
  if (!rawDeviceId || typeof rawDeviceId !== "string" || !rawDeviceId.trim()) {
    return {
      status: "error",
      error: "Invalid arguments: 'deviceId' string is required for get_device_status.",
    };
  }

  const deviceId = rawDeviceId.trim();

  // Verify device ownership strictly for the authenticated user
  const userDevices = await listUserDevices(userId);
  const targetDevice = userDevices.find((d) => d.deviceId === deviceId);

  if (!targetDevice) {
    return {
      status: "error",
      error: `Device '${deviceId}' not found or does not belong to your account.`,
    };
  }

  // Return safe sanitised status (never expose auth tokens or database secrets)
  return {
    status: "success",
    output: {
      deviceId: targetDevice.deviceId,
      deviceName: targetDevice.deviceName,
      platform: targetDevice.platform,
      connectionStatus: targetDevice.connectionStatus,
      lastSeenAt: targetDevice.lastSeenAt,
      pairedAt: targetDevice.pairedAt,
    },
  };
}

/**
 * Tool: open_device_app
 * State-changing physical device action.
 * MUST NOT execute automatically. Prepares a pending confirmation.
 */
async function handleOpenDeviceApp(
  args: Record<string, unknown>,
  userId: string
): Promise<ToolResult> {
  const rawDeviceId = args.deviceId;
  const rawApp = args.app;

  if (!rawDeviceId || typeof rawDeviceId !== "string" || !rawDeviceId.trim()) {
    return {
      status: "error",
      error: "Invalid arguments: 'deviceId' string is required for open_device_app.",
    };
  }

  if (!rawApp || typeof rawApp !== "string" || !rawApp.trim()) {
    return {
      status: "error",
      error: "Invalid arguments: 'app' string is required for open_device_app.",
    };
  }

  const deviceId = rawDeviceId.trim();
  const requestedApp = rawApp.trim();

  // 1. Verify device ownership
  const userDevices = await listUserDevices(userId);
  const targetDevice = userDevices.find((d) => d.deviceId === deviceId);

  if (!targetDevice) {
    return {
      status: "error",
      error: `Device '${deviceId}' not found or does not belong to your account.`,
    };
  }

  // 2. Resolve requested application through server-side allowlist & catalog
  // Never trust a package name supplied by the model or client
  const approvedApp = resolveApprovedApp(requestedApp);
  const catalogApp = !approvedApp ? await findInDeviceCatalog(deviceId, requestedApp) : null;

  if (!approvedApp && !catalogApp) {
    return {
      status: "error",
      error: `Application '${requestedApp}' is not on the approved application allowlist or discovered catalog for this device.`,
    };
  }

  const resolvedAppId = approvedApp ? approvedApp.appId : catalogApp!.appId;
  const resolvedPackageName = approvedApp
    ? approvedApp.packageName
    : catalogApp?.packageName || "";
  const displayName = approvedApp
    ? approvedApp.name
    : catalogApp?.displayName || resolvedAppId;

  // 3. Create pending confirmation record (60-second TTL)
  const pendingAction: PendingActionDetails = {
    tool: "open_device_app",
    deviceId: targetDevice.deviceId,
    deviceName: targetDevice.deviceName,
    app: resolvedAppId,
    appName: displayName,
    packageName: resolvedPackageName,
    description: `Open ${displayName} on ${targetDevice.deviceName}`,
  };

  const validatedArgs = {
    deviceId: targetDevice.deviceId,
    appId: resolvedAppId,
    packageName: resolvedPackageName,
  };

  const confirmation = createPendingConfirmation(
    userId,
    "open_device_app",
    validatedArgs,
    pendingAction
  );

  // Return requiresConfirmation result — DO NOT broadcast command yet
  return {
    status: "requiresConfirmation",
    confirmationId: confirmation.confirmationId,
    tool: "open_device_app",
    arguments: validatedArgs,
    pendingAction,
  };
}

/**
 * Executes a pre-validated, confirmed tool action after explicit user confirmation.
 */
export async function executeConfirmedTool(
  confirmation: PendingConfirmation
): Promise<ToolResultSuccess | ToolResultError> {
  if (confirmation.tool !== "open_device_app") {
    return {
      status: "error",
      error: `Unsupported confirmed tool '${confirmation.tool}'.`,
    };
  }

  const { deviceId, appId, packageName } = confirmation.arguments as {
    deviceId: string;
    appId: string;
    packageName?: string;
  };

  const now = Date.now();
  const expiresAt = now + 45_000;
  const commandId = `cmd_${crypto.randomBytes(12).toString("hex")}`;
  const createdAt = new Date(now).toISOString();

  const commandPayload: Record<string, unknown> = {
    appId,
    ...(packageName ? { packageName } : {}),
  };

  const command: DeviceCommand = {
    commandId,
    targetDeviceId: deviceId,
    commandType: "OPEN_APP",
    createdAt,
    expiresAt,
    payload: commandPayload,
    source: "ultron-web",
  };

  // Broadcast command onto user-scoped Supabase Realtime channel
  const supabase = getSupabase();
  if (supabase) {
    try {
      const channel = supabase.channel(`ultron:devices:${confirmation.userId}`);
      await channel.send({
        type: "broadcast",
        event: "device_command",
        payload: command,
      });
      void supabase.removeChannel(channel);
    } catch (err) {
      console.warn("[Tool Executor] Supabase command broadcast warning:", err);
    }
  }

  return {
    status: "success",
    output: {
      success: true,
      commandId,
      status: "PENDING",
      targetDeviceId: deviceId,
      appId,
      appName: confirmation.pendingAction.appName,
      message: `Command dispatched to open ${confirmation.pendingAction.appName} on ${confirmation.pendingAction.deviceName || deviceId}.`,
    },
  };
}
