import { NextResponse } from "next/server";
import { resolveUserSession, attachSessionCookie } from "@/lib/auth/session";
import { getGeminiClientForUser, getGeminiModel } from "@/lib/geminiService";
import { updateUserKeyStatus } from "@/lib/db/userApiKeyStore";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status =
    (err as { status?: number; statusCode?: number })?.status ||
    (err as { status?: number; statusCode?: number })?.statusCode;

  return (
    status === 503 ||
    status === 429 ||
    msg.includes("503") ||
    msg.includes("unavailable") ||
    msg.includes("high demand") ||
    msg.includes("overloaded") ||
    msg.includes("resource_exhausted") ||
    msg.includes("rate limit") ||
    msg.includes("temporarily") ||
    msg.includes("not found") ||
    msg.includes("404")
  );
}

export async function POST(request: Request) {
  try {
    const { userId, isNew } = resolveUserSession(request);
    const { ai, source } = await getGeminiClientForUser(userId);

    if (!ai) {
      const resp = NextResponse.json(
        {
          error:
            "No Gemini API key configured. Please configure your own Gemini API key in ULTRON Settings (press 'S' or click SETTINGS).",
        },
        { status: 401 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body.message !== "string" || !body.message.trim()) {
      const resp = NextResponse.json(
        { error: "Invalid request: 'message' must be a non-empty string." },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const prompt = body.message.trim();

    // Build contents with conversation history if provided
    let contentsPayload:
      | string
      | Array<{ role: string; parts: Array<{ text: string }> }> = prompt;

    if (Array.isArray(body.history) && body.history.length > 0) {
      const formattedHistory = body.history
        .filter(
          (item: unknown) =>
            item &&
            typeof item === "object" &&
            "text" in item &&
            typeof (item as { text: unknown }).text === "string" &&
            (item as { text: string }).text.trim()
        )
        .map((item: { role?: string; text: string }) => ({
          role:
            item.role === "assistant" || item.role === "model"
              ? "model"
              : "user",
          parts: [{ text: item.text.trim() }],
        }));

      if (formattedHistory.length > 0) {
        contentsPayload = [
          ...formattedHistory,
          { role: "user", parts: [{ text: prompt }] },
        ];
      }
    }

    const primaryModel = getGeminiModel();
    const fallbackModels = [
      primaryModel,
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
    ];
    const modelsToTry = [
      primaryModel,
      ...fallbackModels.filter((m) => m !== primaryModel),
    ];

    let lastError: unknown = null;
    let replyText: string | null = null;
    const MAX_RETRIES_PER_MODEL = 2; // initial attempt + 2 retries = 3 attempts max

    for (const model of modelsToTry) {
      let attempt = 0;
      let success = false;

      while (attempt <= MAX_RETRIES_PER_MODEL) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: contentsPayload,
          });

          replyText = response.text || "No response generated.";
          success = true;
          break;
        } catch (err: unknown) {
          lastError = err;
          attempt++;

          if (attempt <= MAX_RETRIES_PER_MODEL && isTransientError(err)) {
            const delay = Math.min(500 * Math.pow(2, attempt - 1), 2000);
            await sleep(delay);
            continue;
          }

          // Check for authentication error
          const errMsg = (
            err instanceof Error ? err.message : String(err)
          ).toLowerCase();
          const isAuthError =
            errMsg.includes("api_key_invalid") ||
            errMsg.includes("api key not valid") ||
            errMsg.includes("unauthenticated") ||
            errMsg.includes("permission_denied") ||
            errMsg.includes("invalid api key");

          if (isAuthError) {
            if (source === "user") {
              await updateUserKeyStatus(userId, "invalid", "Authentication failed");
            }

            const errorMsg =
              source === "user"
                ? "Your configured Gemini API key is invalid or unauthorized. Please update it in Settings."
                : "Invalid or unauthorized development GEMINI_API_KEY. Please configure your own API key in Settings.";

            const resp = NextResponse.json(
              { error: errorMsg },
              { status: 401 }
            );
            if (isNew) attachSessionCookie(resp, userId);
            return resp;
          }

          // Move to next candidate model if transient error or model error
          break;
        }
      }

      if (success && replyText !== null) {
        const resp = NextResponse.json({
          text: replyText,
          reply: replyText,
          source,
        });
        if (isNew) attachSessionCookie(resp, userId);
        return resp;
      }
    }

    // All retries and fallback models failed
    console.error("Gemini request failed after retries and fallbacks:", lastError);

    if (isTransientError(lastError)) {
      const resp = NextResponse.json(
        {
          error:
            "Gemini is temporarily busy. Please try again in a few seconds.",
        },
        { status: 503 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const resp = NextResponse.json(
      {
        error:
          "Unable to process request with Gemini. Please try again shortly.",
      },
      { status: 500 }
    );
    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  } catch (err: unknown) {
    console.error("Unexpected server error in /api/chat:", err);
    return NextResponse.json(
      {
        error: "An unexpected error occurred. Please try again later.",
      },
      { status: 500 }
    );
  }
}
