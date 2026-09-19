/**
 * lib/security/payloadValidators.ts
 *
 * Centralized request validation and payload limits for inference endpoints:
 * 1. CSRF / Same-Origin validation.
 * 2. Chat payload limits: Body <= 64KB, message <= 4,000 chars, history <= 50 items (max 30,000 chars).
 * 3. STT payload limits: Audio <= 10MB, whitelisted audio MIME types (WebM, WAV, OGG, MP3, MP4).
 * 4. TTS payload limits: Body <= 16KB, text <= 2,000 chars, validated voice, validated model,
 *    speed [0.5, 2.0], no arbitrary client upstream URLs.
 */

import { NextResponse } from "next/server";

export const CHAT_MAX_BODY_BYTES = 64 * 1024; // 64 KB
export const CHAT_MAX_MESSAGE_CHARS = 4_000;
export const CHAT_MAX_HISTORY_ITEMS = 50;
export const CHAT_MAX_HISTORY_TOTAL_CHARS = 30_000;

export const STT_MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB
export const STT_ALLOWED_MIME_TYPES = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
]);

export const TTS_MAX_BODY_BYTES = 16 * 1024; // 16 KB
export const TTS_MAX_TEXT_CHARS = 2_000;
const SAFE_VOICE_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;
const SAFE_MODEL_REGEX = /^[a-zA-Z0-9_.:-]{1,64}$/;

/**
 * Validates that cross-origin requests from browsers originate from the same host.
 */
export function validateSameOrigin(request: Request): { valid: boolean; errorResponse?: NextResponse } {
  const origin = request.headers.get("origin");
  if (!origin) {
    // Non-browser or direct companion request without Origin header
    return { valid: true };
  }

  try {
    const originUrl = new URL(origin);
    const hostHeader = request.headers.get("host");

    if (hostHeader) {
      const hostWithoutPort = hostHeader.split(":")[0].toLowerCase();
      const originHost = originUrl.hostname.toLowerCase();

      // Permit localhost variants during local development
      const isLocalhost =
        (originHost === "localhost" || originHost === "127.0.0.1") &&
        (hostWithoutPort === "localhost" || hostWithoutPort === "127.0.0.1");

      if (!isLocalhost && originHost !== hostWithoutPort) {
        return {
          valid: false,
          errorResponse: NextResponse.json(
            { error: "forbidden", message: "Cross-origin request rejected." },
            { status: 403 }
          ),
        };
      }
    }
  } catch {
    return {
      valid: false,
      errorResponse: NextResponse.json(
        { error: "forbidden", message: "Invalid Origin header." },
        { status: 403 }
      ),
    };
  }

  return { valid: true };
}

export interface ValidatedChatPayload {
  message: string;
  history: Array<{ role: "assistant" | "user"; content: string }>;
  voiceMode: boolean;
}

/**
 * Validates and extracts Chat request payload.
 */
export async function validateChatPayload(
  request: Request
): Promise<
  | { success: true; data: ValidatedChatPayload }
  | { success: false; errorResponse: NextResponse }
> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > CHAT_MAX_BODY_BYTES) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: "payload_too_large",
          message: `Request body exceeds maximum allowed size of ${CHAT_MAX_BODY_BYTES / 1024}KB.`,
        },
        { status: 413 }
      ),
    };
  }

  const rawText = await request.text().catch(() => "");
  if (!rawText || rawText.length > CHAT_MAX_BODY_BYTES) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: "payload_too_large",
          message: `Request body exceeds maximum allowed size of ${CHAT_MAX_BODY_BYTES / 1024}KB.`,
        },
        { status: 413 }
      ),
    };
  }

  let body: any;
  try {
    body = JSON.parse(rawText);
  } catch {
    return {
      success: false,
      errorResponse: NextResponse.json(
        { error: "invalid_payload", message: "Invalid JSON in request body." },
        { status: 400 }
      ),
    };
  }

  if (!body || typeof body.message !== "string" || !body.message.trim()) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        { error: "invalid_payload", message: "Invalid request: 'message' must be a non-empty string." },
        { status: 400 }
      ),
    };
  }

  const message = body.message.trim();
  if (message.length > CHAT_MAX_MESSAGE_CHARS) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: "invalid_payload",
          message: `Message length (${message.length}) exceeds maximum limit of ${CHAT_MAX_MESSAGE_CHARS} characters.`,
        },
        { status: 400 }
      ),
    };
  }

  const formattedHistory: Array<{ role: "assistant" | "user"; content: string }> = [];
  if (Array.isArray(body.history)) {
    if (body.history.length > CHAT_MAX_HISTORY_ITEMS) {
      return {
        success: false,
        errorResponse: NextResponse.json(
          {
            error: "invalid_payload",
            message: `Conversation history exceeds maximum of ${CHAT_MAX_HISTORY_ITEMS} messages.`,
          },
          { status: 400 }
        ),
      };
    }

    let totalHistoryChars = 0;
    for (const item of body.history) {
      if (item && typeof item === "object") {
        const text = (
          typeof item.text === "string" ? item.text : item.content || ""
        ).trim();
        if (text) {
          if (text.length > CHAT_MAX_MESSAGE_CHARS) {
            return {
              success: false,
              errorResponse: NextResponse.json(
                {
                  error: "invalid_payload",
                  message: `Individual history item exceeds ${CHAT_MAX_MESSAGE_CHARS} characters limit.`,
                },
                { status: 400 }
              ),
            };
          }
          totalHistoryChars += text.length;
          if (totalHistoryChars > CHAT_MAX_HISTORY_TOTAL_CHARS) {
            return {
              success: false,
              errorResponse: NextResponse.json(
                {
                  error: "invalid_payload",
                  message: `Total conversation history exceeds ${CHAT_MAX_HISTORY_TOTAL_CHARS} characters limit.`,
                },
                { status: 400 }
              ),
            };
          }

          const role: "assistant" | "user" =
            item.role === "assistant" || item.role === "model" ? "assistant" : "user";
          formattedHistory.push({ role, content: text });
        }
      }
    }
  }

  return {
    success: true,
    data: {
      message,
      history: formattedHistory,
      voiceMode: Boolean(body.voiceMode),
    },
  };
}

export interface ValidatedSttPayload {
  file: Blob | File;
  fileName: string;
  mimeType: string;
}

/**
 * Validates and extracts STT multipart upload payload.
 */
export async function validateSttPayload(
  request: Request
): Promise<
  | { success: true; data: ValidatedSttPayload }
  | { success: false; errorResponse: NextResponse }
> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > STT_MAX_AUDIO_BYTES) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: "payload_too_large",
          message: `Audio file exceeds maximum size limit of ${STT_MAX_AUDIO_BYTES / (1024 * 1024)}MB.`,
        },
        { status: 413 }
      ),
    };
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        { error: "invalid_payload", message: "STT failed: Invalid form data in request." },
        { status: 400 }
      ),
    };
  }

  const file = formData.get("file") as Blob | File | null;
  if (!file || (file instanceof Blob && file.size === 0)) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        { error: "invalid_payload", message: "STT failed: Missing or empty audio file in form data." },
        { status: 400 }
      ),
    };
  }

  if (file.size > STT_MAX_AUDIO_BYTES) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: "payload_too_large",
          message: `Audio file size (${(file.size / (1024 * 1024)).toFixed(2)}MB) exceeds maximum limit of 10MB.`,
        },
        { status: 413 }
      ),
    };
  }

  const rawMime = (file.type || "audio/webm").toLowerCase().trim();
  const normalizedMime = rawMime.split(";")[0].trim();

  const isAllowed =
    STT_ALLOWED_MIME_TYPES.has(rawMime) ||
    STT_ALLOWED_MIME_TYPES.has(normalizedMime) ||
    normalizedMime.startsWith("audio/");

  if (!isAllowed) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: "unsupported_media_type",
          message: `Unsupported audio format '${rawMime}'. Allowed types: WebM, WAV, OGG, MP3, MP4.`,
        },
        { status: 400 }
      ),
    };
  }

  const fileName =
    file instanceof File && file.name ? file.name.replace(/[^a-zA-Z0-9._-]/g, "") : "speech.webm";

  return {
    success: true,
    data: {
      file,
      fileName,
      mimeType: rawMime,
    },
  };
}

export interface ValidatedTtsPayload {
  text: string;
  voiceId?: string;
  model?: string;
  speed?: number;
}

/**
 * Validates and extracts TTS request payload.
 */
export async function validateTtsPayload(
  request: Request
): Promise<
  | { success: true; data: ValidatedTtsPayload }
  | { success: false; errorResponse: NextResponse }
> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > TTS_MAX_BODY_BYTES) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: "payload_too_large",
          message: `Request body exceeds maximum size of ${TTS_MAX_BODY_BYTES / 1024}KB.`,
        },
        { status: 413 }
      ),
    };
  }

  const rawText = await request.text().catch(() => "");
  if (!rawText || rawText.length > TTS_MAX_BODY_BYTES) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: "payload_too_large",
          message: `Request body exceeds maximum size of ${TTS_MAX_BODY_BYTES / 1024}KB.`,
        },
        { status: 413 }
      ),
    };
  }

  let body: any;
  try {
    body = JSON.parse(rawText);
  } catch {
    return {
      success: false,
      errorResponse: NextResponse.json(
        { error: "invalid_payload", message: "Invalid JSON in request body." },
        { status: 400 }
      ),
    };
  }

  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        { error: "invalid_payload", message: "TTS failed: 'text' must be a non-empty string." },
        { status: 400 }
      ),
    };
  }

  const text = body.text.trim();
  if (text.length > TTS_MAX_TEXT_CHARS) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: "invalid_payload",
          message: `TTS text length (${text.length}) exceeds maximum limit of ${TTS_MAX_TEXT_CHARS} characters.`,
        },
        { status: 400 }
      ),
    };
  }

  let voiceId: string | undefined = undefined;
  if (typeof body.voiceId === "string" && body.voiceId.trim()) {
    const candidate = body.voiceId.trim();
    if (!SAFE_VOICE_REGEX.test(candidate)) {
      return {
        success: false,
        errorResponse: NextResponse.json(
          { error: "invalid_payload", message: "Invalid voice identifier format." },
          { status: 400 }
        ),
      };
    }
    voiceId = candidate;
  }

  let model: string | undefined = undefined;
  if (typeof body.model === "string" && body.model.trim()) {
    const candidateModel = body.model.trim();
    if (!SAFE_MODEL_REGEX.test(candidateModel)) {
      return {
        success: false,
        errorResponse: NextResponse.json(
          { error: "invalid_payload", message: "Invalid model identifier format." },
          { status: 400 }
        ),
      };
    }
    model = candidateModel;
  }

  let speed: number | undefined = undefined;
  if (typeof body.speed === "number" && !isNaN(body.speed)) {
    if (body.speed < 0.5 || body.speed > 2.0) {
      return {
        success: false,
        errorResponse: NextResponse.json(
          { error: "invalid_payload", message: "Speed must be between 0.5 and 2.0." },
          { status: 400 }
        ),
      };
    }
    speed = body.speed;
  }

  // Client cannot select arbitrary upstream URLs (apiUrl, KOKORO_API_URL, etc.)
  return {
    success: true,
    data: {
      text,
      voiceId,
      model,
      speed,
    },
  };
}
