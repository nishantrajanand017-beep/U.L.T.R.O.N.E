import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

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
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "GEMINI_API_KEY is not configured on the server. Please add your API key to .env.local and restart the server.",
        },
        { status: 500 }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body.message !== "string" || !body.message.trim()) {
      return NextResponse.json(
        { error: "Invalid request: 'message' must be a non-empty string." },
        { status: 400 }
      );
    }

    const prompt = body.message.trim();
    const ai = new GoogleGenAI({ apiKey });

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

    const primaryModel = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
    const fallbackModels = [
      "gemini-3.6-flash",
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
            errMsg.includes("unauthenticated") ||
            errMsg.includes("permission_denied") ||
            errMsg.includes("invalid api key");

          if (isAuthError) {
            return NextResponse.json(
              {
                error:
                  "Invalid or unauthorized GEMINI_API_KEY. Please verify your API key in .env.local.",
              },
              { status: 401 }
            );
          }

          // Move to next candidate model if transient error or model error
          break;
        }
      }

      if (success && replyText !== null) {
        return NextResponse.json({
          text: replyText,
          reply: replyText,
        });
      }
    }

    // All retries and fallback models failed
    console.error("Gemini request failed after retries and fallbacks:", lastError);

    if (isTransientError(lastError)) {
      return NextResponse.json(
        {
          error:
            "Gemini is temporarily busy. Please try again in a few seconds.",
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        error:
          "Unable to process request with Gemini. Please try again shortly.",
      },
      { status: 500 }
    );
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
