import { GoogleGenAI } from "@google/genai";
import { getUserDecryptedApiKey } from "./db/userApiKeyStore";
import { maskApiKey } from "./crypto/encryption";

export type GeminiClientSource = "user" | "system_fallback" | "none";

export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

export interface ResolvedGeminiClient {
  ai: GoogleGenAI | null;
  source: GeminiClientSource;
  keyHint: string | null;
}

/**
 * Resolves the appropriate GoogleGenAI client instance for a given user.
 * 1. Checks for user-configured key in the secure store.
 * 2. If absent, falls back to the development environment key (GEMINI_API_KEY) if available.
 * 3. Returns null if neither is configured.
 */
export async function getGeminiClientForUser(
  userId: string
): Promise<ResolvedGeminiClient> {
  // 1. Check user-configured key
  if (userId) {
    const userKey = await getUserDecryptedApiKey(userId);
    if (userKey && userKey.trim().length > 0) {
      return {
        ai: new GoogleGenAI({ apiKey: userKey.trim() }),
        source: "user",
        keyHint: maskApiKey(userKey),
      };
    }
  }

  // 2. Fallback to system / dev environment key
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey && envKey.length > 0) {
    return {
      ai: new GoogleGenAI({ apiKey: envKey }),
      source: "system_fallback",
      keyHint: maskApiKey(envKey),
    };
  }

  // 3. No key available
  return {
    ai: null,
    source: "none",
    keyHint: null,
  };
}

export interface KeyTestResult {
  valid: boolean;
  status: "valid" | "invalid" | "error";
  message: string;
}

/**
 * Validates a candidate Gemini API key by making a lightweight verification request.
 * Ensures the raw key is never returned or leaked in logs or errors.
 */
export async function validateGeminiApiKey(apiKey: string): Promise<KeyTestResult> {
  const trimmed = apiKey?.trim();
  if (!trimmed) {
    return {
      valid: false,
      status: "invalid",
      message: "API key is required and cannot be empty.",
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey: trimmed });

    // Test with a minimal generation call to confirm valid authentication and model access
    const testModel = getGeminiModel();
    const response = await ai.models.generateContent({
      model: testModel,
      contents: "Hi",
    });

    if (response && response.text !== undefined) {
      return {
        valid: true,
        status: "valid",
        message: "Gemini connection established successfully. Key is valid.",
      };
    }

    return {
      valid: true,
      status: "valid",
      message: "Connection verified.",
    };
  } catch (err: unknown) {
    const rawMsg = (err instanceof Error ? err.message : String(err)).toLowerCase();

    // Check for invalid or unauthorized API key
    if (
      rawMsg.includes("api_key_invalid") ||
      rawMsg.includes("api key not valid") ||
      rawMsg.includes("unauthenticated") ||
      rawMsg.includes("permission_denied") ||
      rawMsg.includes("invalid api key") ||
      rawMsg.includes("forbidden") ||
      rawMsg.includes("403") ||
      rawMsg.includes("401")
    ) {
      return {
        valid: false,
        status: "invalid",
        message: "Invalid Gemini API key. Please check your key in Google AI Studio and try again.",
      };
    }

    // Check for rate limit or quota exhaustion
    if (rawMsg.includes("resource_exhausted") || rawMsg.includes("429") || rawMsg.includes("quota")) {
      return {
        valid: true, // Key is recognized and valid, but quota is limited
        status: "valid",
        message: "API key is valid, but current quota/rate limits have been reached.",
      };
    }

    // General network or service error
    return {
      valid: false,
      status: "error",
      message: "Gemini connection test encountered a temporary network or service error. Please try again shortly.",
    };
  }
}
