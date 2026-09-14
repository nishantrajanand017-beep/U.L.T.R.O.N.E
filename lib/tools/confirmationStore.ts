/**
 * lib/tools/confirmationStore.ts
 *
 * In-memory secure confirmation store for dangerous/state-changing tool actions (e.g. open_device_app).
 *
 * Security Guarantees:
 * 1. Strict user-binding: confirmation can only be retrieved or consumed by the owning userId.
 * 2. 60-second TTL: automatically invalidated after expiration.
 * 3. Single-use: once consumed, the confirmation is deleted immediately to prevent replay attacks.
 * 4. Tamper-proof: the browser only supplies confirmationId; execution arguments are retrieved from this store.
 */

import crypto from "node:crypto";
import type { PendingActionDetails } from "./types";

export interface PendingConfirmation {
  confirmationId: string;
  userId: string;
  tool: string;
  arguments: Record<string, unknown>;
  pendingAction: PendingActionDetails;
  createdAt: number;
  expiresAt: number;
}

export const DEFAULT_CONFIRMATION_TTL_MS = 60_000; // 60 seconds

// In-memory registry of active pending confirmations
const confirmations = new Map<string, PendingConfirmation>();

/**
 * Prunes expired confirmations from memory.
 */
function pruneExpiredConfirmations(): void {
  const now = Date.now();
  for (const [id, item] of confirmations.entries()) {
    if (now >= item.expiresAt) {
      confirmations.delete(id);
    }
  }
}

/**
 * Creates a new pending confirmation bound to the authenticated user.
 */
export function createPendingConfirmation(
  userId: string,
  tool: string,
  validatedArgs: Record<string, unknown>,
  pendingAction: PendingActionDetails,
  ttlMs = DEFAULT_CONFIRMATION_TTL_MS
): PendingConfirmation {
  pruneExpiredConfirmations();

  const now = Date.now();
  const confirmationId = `conf_${crypto.randomBytes(16).toString("hex")}`;

  const confirmation: PendingConfirmation = {
    confirmationId,
    userId,
    tool,
    arguments: validatedArgs,
    pendingAction,
    createdAt: now,
    expiresAt: now + ttlMs,
  };

  confirmations.set(confirmationId, confirmation);
  return confirmation;
}

/**
 * Retrieves a confirmation record if it exists, belongs to the userId, and has not expired.
 */
export function getPendingConfirmation(
  confirmationId: string,
  userId: string
): PendingConfirmation | null {
  pruneExpiredConfirmations();

  if (!confirmationId || !userId) return null;
  const item = confirmations.get(confirmationId);
  if (!item) return null;

  // Enforce tenant isolation
  if (item.userId !== userId) {
    return null;
  }

  // Enforce expiration
  if (Date.now() >= item.expiresAt) {
    confirmations.delete(confirmationId);
    return null;
  }

  return item;
}

/**
 * Atomically retrieves and removes a confirmation for execution.
 * Prevents reuse / replay attacks.
 */
export function consumePendingConfirmation(
  confirmationId: string,
  userId: string
): PendingConfirmation | null {
  const item = getPendingConfirmation(confirmationId, userId);
  if (!item) return null;

  confirmations.delete(confirmationId);
  return item;
}

/**
 * Cancels a pending confirmation on explicit user rejection.
 */
export function cancelPendingConfirmation(
  confirmationId: string,
  userId: string
): boolean {
  const item = getPendingConfirmation(confirmationId, userId);
  if (!item) return false;

  confirmations.delete(confirmationId);
  return true;
}

/**
 * Test helper to clear store (used in test suites)
 */
export function _clearConfirmationsForTesting(): void {
  confirmations.clear();
}
