/**
 * app/api/memories/route.ts
 *
 * Dedicated REST API for inspecting, saving, and deleting user-scoped persistent memories.
 * Enforces:
 * 1. User authentication via session cookies
 * 2. Strict tenant isolation (all operations bound to resolved userId)
 * 3. Input validation and limits
 * 4. Safe single or bulk deletion
 */

import { NextResponse } from "next/server";
import { resolveUserSession, attachSessionCookie } from "@/lib/auth/session";
import {
  getUserMemories,
  saveMemory,
  deleteMemory,
  clearUserMemories,
} from "@/lib/memory/memoryStore";

/**
 * GET /api/memories
 * Returns memories strictly belonging to the authenticated user.
 */
export async function GET(request: Request) {
  const { userId, isAuthenticated, isAnonymous, isNew } = await resolveUserSession(request);

  if (!userId || !isAuthenticated) {
    return NextResponse.json(
      { error: "Unauthorized: Authentication required." },
      { status: 401 }
    );
  }

  if (isAnonymous) {
    return NextResponse.json(
      { error: "Forbidden: Guest sessions cannot access or store persistent memories." },
      { status: 403 }
    );
  }

  try {
    const memories = await getUserMemories(userId);
    const resp = NextResponse.json({
      success: true,
      count: memories.length,
      memories,
    });
    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  } catch (err: unknown) {
    console.error("[Memories API GET Error]", err);
    const resp = NextResponse.json(
      { error: "Failed to retrieve memories for user." },
      { status: 500 }
    );
    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  }
}

/**
 * POST /api/memories
 * Saves or updates a memory explicitly for the authenticated user.
 */
export async function POST(request: Request) {
  const { userId, isAuthenticated, isAnonymous, isNew } = await resolveUserSession(request);

  if (!userId || !isAuthenticated) {
    return NextResponse.json(
      { error: "Unauthorized: Authentication required." },
      { status: 401 }
    );
  }

  if (isAnonymous) {
    return NextResponse.json(
      { error: "Forbidden: Guest sessions cannot access or store persistent memories." },
      { status: 403 }
    );
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      const resp = NextResponse.json(
        { error: "Invalid JSON body in request." },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const reqBody = body as { category?: unknown; key?: unknown; value?: unknown };
    if (!reqBody || typeof reqBody !== "object") {
      const resp = NextResponse.json(
        { error: "Request body must be a JSON object." },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const saved = await saveMemory(userId, reqBody.category, reqBody.key, reqBody.value);

    const resp = NextResponse.json({
      success: true,
      memory: saved,
    });
    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to save memory.";
    const status = msg.includes("exceeded") || msg.includes("Invalid") ? 400 : 500;
    const resp = NextResponse.json({ error: msg }, { status });
    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  }
}

/**
 * DELETE /api/memories
 * Deletes a single memory (?id=...) or clears all memories for the user (?all=true).
 */
export async function DELETE(request: Request) {
  const { userId, isAuthenticated, isAnonymous, isNew } = await resolveUserSession(request);

  if (!userId || !isAuthenticated) {
    return NextResponse.json(
      { error: "Unauthorized: Authentication required." },
      { status: 401 }
    );
  }

  if (isAnonymous) {
    return NextResponse.json(
      { error: "Forbidden: Guest sessions cannot access or store persistent memories." },
      { status: 403 }
    );
  }
  const url = new URL(request.url);
  const memoryId = url.searchParams.get("id");
  const clearAll = url.searchParams.get("all") === "true";

  try {
    if (clearAll) {
      const count = await clearUserMemories(userId);
      const resp = NextResponse.json({
        success: true,
        clearedCount: count,
        message: `Successfully cleared ${count} memories.`,
      });
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    if (!memoryId || !memoryId.trim()) {
      const resp = NextResponse.json(
        { error: "Invalid request: Supply 'id' parameter or 'all=true'." },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const deleted = await deleteMemory(userId, memoryId.trim());
    if (!deleted) {
      const resp = NextResponse.json(
        { error: "Memory not found or does not belong to your account." },
        { status: 404 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const resp = NextResponse.json({
      success: true,
      memoryId: memoryId.trim(),
      message: "Memory successfully deleted.",
    });
    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  } catch (err: unknown) {
    console.error("[Memories API DELETE Error]", err);
    const resp = NextResponse.json(
      { error: "Failed to delete memory." },
      { status: 500 }
    );
    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  }
}
