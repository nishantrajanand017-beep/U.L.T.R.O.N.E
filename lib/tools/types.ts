/**
 * lib/tools/types.ts
 *
 * Core TypeScript definitions for the ULTRON Tool Calling and Dispatcher architecture.
 * Ensures strict typing, user-scoped contexts, and safety-first confirmation protocols.
 */

export interface ToolFunctionParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: Record<string, unknown>;
}

export interface ToolFunctionParameters {
  type: "object";
  properties: Record<string, ToolFunctionParameterProperty>;
  required?: string[];
}

export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: ToolFunctionParameters;
}

export interface ToolDefinition {
  type: "function";
  function: ToolFunctionDefinition;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // Raw JSON string from model
  };
}

export interface ToolExecutionContext {
  /** Authenticated user ID (must always be present for tenant isolation) */
  userId: string;
  /** Whether the user is an anonymous/guest session */
  isAnonymous?: boolean;
}

export interface PendingActionDetails {
  tool: string;
  deviceId: string;
  deviceName?: string;
  app: string;
  appName?: string;
  packageName?: string;
  description: string;
}

export interface ToolResultSuccess {
  status: "success";
  output: Record<string, unknown> | string;
}

export interface ToolResultError {
  status: "error";
  error: string;
}

export interface ToolResultRequiresConfirmation {
  status: "requiresConfirmation";
  confirmationId: string;
  tool: string;
  arguments: Record<string, unknown>;
  pendingAction: PendingActionDetails;
}

export type ToolResult =
  | ToolResultSuccess
  | ToolResultError
  | ToolResultRequiresConfirmation;
