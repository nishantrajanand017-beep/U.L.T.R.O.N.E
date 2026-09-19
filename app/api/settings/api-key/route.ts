import { NextResponse } from "next/server";
import { resolveUserSession, attachSessionCookie } from "@/lib/auth/session";
import {
  getUserApiKeyPublicInfo,
  saveUserApiKey,
  deleteUserApiKey,
} from "@/lib/db/userApiKeyStore";

export async function GET(request: Request) {
  try {
    const { userId, isAuthenticated, isAnonymous, isNew } = await resolveUserSession(request);
    if (!userId || !isAuthenticated) {
      return NextResponse.json(
        { error: "Unauthorized: Authentication required." },
        { status: 401 }
      );
    }
    if (isAnonymous) {
      return NextResponse.json(
        { error: "Forbidden: Guest sessions cannot access or modify API key settings." },
        { status: 403 }
      );
    }
    const info = await getUserApiKeyPublicInfo(userId);

    const hasEnvFallback = Boolean(process.env.GEMINI_API_KEY?.trim());

    const response = NextResponse.json({
      ...info,
      hasEnvFallback,
    });

    if (isNew) {
      attachSessionCookie(response, userId);
    }

    return response;
  } catch (err) {
    console.error("[Settings] Error fetching API key info:", err);
    return NextResponse.json(
      { error: "Failed to retrieve API key settings." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const { userId, isAuthenticated, isAnonymous, isNew } = await resolveUserSession(request);
    if (!userId || !isAuthenticated) {
      return NextResponse.json(
        { error: "Unauthorized: Authentication required." },
        { status: 401 }
      );
    }
    if (isAnonymous) {
      return NextResponse.json(
        { error: "Forbidden: Guest sessions cannot access or modify API key settings." },
        { status: 403 }
      );
    }
    const body = await request.json().catch(() => null);

    if (!body || typeof body.apiKey !== "string" || !body.apiKey.trim()) {
      return NextResponse.json(
        { error: "Invalid request: 'apiKey' must be a non-empty string." },
        { status: 400 }
      );
    }

    const provider = body.provider === "gemini" ? "gemini" : "gemini";
    const updatedInfo = await saveUserApiKey(userId, body.apiKey.trim(), provider);

    const hasEnvFallback = Boolean(process.env.GEMINI_API_KEY?.trim());

    const response = NextResponse.json({
      success: true,
      message: "API key securely saved and encrypted.",
      ...updatedInfo,
      hasEnvFallback,
    });

    if (isNew) {
      attachSessionCookie(response, userId);
    }

    return response;
  } catch (err) {
    console.error("[Settings] Error saving API key:", err);
    return NextResponse.json(
      { error: "Failed to save API key." },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { userId, isAuthenticated, isAnonymous, isNew } = await resolveUserSession(request);
    if (!userId || !isAuthenticated) {
      return NextResponse.json(
        { error: "Unauthorized: Authentication required." },
        { status: 401 }
      );
    }
    if (isAnonymous) {
      return NextResponse.json(
        { error: "Forbidden: Guest sessions cannot access or modify API key settings." },
        { status: 403 }
      );
    }
    const removed = await deleteUserApiKey(userId);

    const hasEnvFallback = Boolean(process.env.GEMINI_API_KEY?.trim());

    const response = NextResponse.json({
      success: true,
      message: removed ? "API key removed successfully." : "No configured API key to remove.",
      isConfigured: false,
      status: "not_configured",
      keyHint: null,
      lastTestedAt: null,
      hasEnvFallback,
    });

    if (isNew) {
      attachSessionCookie(response, userId);
    }

    return response;
  } catch (err) {
    console.error("[Settings] Error removing API key:", err);
    return NextResponse.json(
      { error: "Failed to remove API key." },
      { status: 500 }
    );
  }
}
