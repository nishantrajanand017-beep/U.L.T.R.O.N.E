/**
 * lib/tools/registry.ts
 *
 * Centralized tool registry defining safe, authorized tools for ULTRON (Qwen3-8B).
 * Strictly contains ONLY:
 * 1. get_device_status
 * 2. get_system_time
 * 3. open_device_app
 *
 * Arbitrary shell, code execution, or package installation tools are forbidden.
 */

import type { ToolDefinition } from "./types";

export const TOOL_GET_DEVICE_STATUS: ToolDefinition = {
  type: "function",
  function: {
    name: "get_device_status",
    description:
      "Check the connectivity, heartbeat, and status of a paired companion Android device belonging to the user. Returns device name, online/offline status, and last seen timestamp.",
    parameters: {
      type: "object",
      properties: {
        deviceId: {
          type: "string",
          description: "The unique identifier of the paired device (e.g. dev_...).",
        },
      },
      required: ["deviceId"],
    },
  },
};

export const TOOL_GET_SYSTEM_TIME: ToolDefinition = {
  type: "function",
  function: {
    name: "get_system_time",
    description:
      "Retrieve the current system time, date, day of week, and timezone from the ULTRON Core server.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

export const TOOL_OPEN_DEVICE_APP: ToolDefinition = {
  type: "function",
  function: {
    name: "open_device_app",
    description:
      "Request to open an approved application (such as WhatsApp, Telegram, Chrome, YouTube, Gmail, Settings, or a discovered installed app) on the user's paired Android device. This action interacts with a physical device and requires explicit user confirmation before launch.",
    parameters: {
      type: "object",
      properties: {
        deviceId: {
          type: "string",
          description: "The unique identifier of the user's paired target device.",
        },
        app: {
          type: "string",
          description:
            "The logical application name or identifier to open (e.g. 'whatsapp', 'telegram', 'chrome', 'youtube', 'gmail', 'settings'). Never supply raw package names.",
        },
      },
      required: ["deviceId", "app"],
    },
  },
};

export const ULTRON_TOOLS: ToolDefinition[] = [
  TOOL_GET_DEVICE_STATUS,
  TOOL_GET_SYSTEM_TIME,
  TOOL_OPEN_DEVICE_APP,
];

export const REGISTERED_TOOL_NAMES = new Set<string>(
  ULTRON_TOOLS.map((t) => t.function.name)
);

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return ULTRON_TOOLS.find((t) => t.function.name === name);
}

export function isToolRegistered(name: string): boolean {
  return REGISTERED_TOOL_NAMES.has(name);
}
