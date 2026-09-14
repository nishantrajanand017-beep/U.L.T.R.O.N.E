/**
 * app/api/tools/confirm/route.ts
 *
 * Dedicated endpoint for confirming pending, pre-validated tool actions.
 * Enforces:
 * 1. User authentication
 * 2. Strict tenant matching
 * 3. 60-second expiration
 * 4. Single-use consumption (no replay attacks)
 * 5. Execution of pre-validated server parameters (client arguments ignored)
 */

import { NextResponse } from "next/server";
import { resolveUserSession, attachSessionCookie } from "@/lib/auth/session";
import { consumePendingConfirmation } from "@/lib/tools/confirmationStore";
import { executeConfirmedTool } from "@/lib/tools/executor";

export async function POST(request: Request) {
  const { userId, isAuthenticated, isNew } = await resolveUserSession(request);

  if (!userId || !isAuthenticated) {
    return NextResponse.json(
      { error: "Unauthorized: Authentication required." },
      { status: 401 }
    );
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      const resp = NextResponse.json(
        { error: "Invalid request: Expected JSON body." },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const reqBody = body as { confirmationId?: unknown };
    const rawConfirmationId = reqBody?.confirmationId;

    if (!rawConfirmationId || typeof rawConfirmationId !== "string" || !rawConfirmationId.trim()) {
      const resp = NextResponse.json(
        { error: "Invalid request: 'confirmationId' string is required." },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const confirmationId = rawConfirmationId.trim();

    // Atomically retrieve and consume confirmation (bound to userId)
    const confirmation = consumePendingConfirmation(confirmationId, userId);

    if (!confirmation) {
      const resp = NextResponse.json(
        {
          error:
            "Confirmation request expired, invalid, or belongs to another user session.",
        },
        { status: 404 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    // Execute the confirmed action with server-verified arguments
    const result = await executeConfirmedTool(confirmation);

    if (result.status === "error") {
      const resp = NextResponse.json(
        { error: result.error || "Failed to execute confirmed action." },
        { status: 500 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const resp = NextResponse.json({
      success: true,
      result: result.output,
    });

    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  } catch (err: unknown) {
    console.error("[Tools Confirm API Error]", err);
    const resp = NextResponse.json(
      { error: "An unexpected error occurred during confirmation execution." },
      { status: 500 }
    );
    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  }
}
