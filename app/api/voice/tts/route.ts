import { NextResponse } from "next/server";
import { resolveUserSession } from "@/lib/auth/session";
import {
  generateKokoroSpeech,
  DEFAULT_KOKORO_VOICE,
} from "@/lib/kokoroService";
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_VOICE_NAME,
} from "@/lib/elevenlabsService";
import {
  checkEndpointRateLimit,
  createRateLimitHeaders,
  createRateLimitErrorResponse,
} from "@/lib/security/rateLimiter";
import {
  acquireConcurrencySlot,
  createConcurrencyErrorResponse,
} from "@/lib/security/concurrencyGuard";
import {
  validateSameOrigin,
  validateTtsPayload,
} from "@/lib/security/payloadValidators";

// Retain backwards compatibility for existing imports
export { DEFAULT_ELEVENLABS_VOICE_ID, DEFAULT_ELEVENLABS_VOICE_NAME, DEFAULT_KOKORO_VOICE };

export async function POST(request: Request) {
  // 1. Same-Origin CSRF validation
  const originCheck = validateSameOrigin(request);
  if (!originCheck.valid && originCheck.errorResponse) {
    return originCheck.errorResponse;
  }

  // 2. Authentication check: TTS requires verified user identity
  const { userId, isAuthenticated } = await resolveUserSession(request);
  if (!userId || !isAuthenticated) {
    return NextResponse.json(
      { error: "Unauthorized: Authentication required." },
      { status: 401 }
    );
  }

  // 3. Payload validation (body <= 16KB, text <= 2,000 chars, validated voiceId & speed)
  const payloadResult = await validateTtsPayload(request);
  if (!payloadResult.success) {
    return payloadResult.errorResponse;
  }

  const { text: textToSpeak, voiceId, speed } = payloadResult.data;

  // 4. Rate-limit check (BEFORE any expensive Kokoro CPU inference)
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip");

  const testLimitHeader =
    process.env.NODE_ENV !== "production"
      ? parseInt(request.headers.get("x-test-rate-limit") || "0", 10) || undefined
      : undefined;

  const rateLimitResult = await checkEndpointRateLimit("tts", userId, clientIp, testLimitHeader);
  if (!rateLimitResult.allowed) {
    return createRateLimitErrorResponse(rateLimitResult);
  }

  const rateLimitHeaders = createRateLimitHeaders(rateLimitResult);

  // 5. Concurrency & backpressure protection
  const slot = acquireConcurrencySlot("tts");
  if (!slot.success) {
    return createConcurrencyErrorResponse("tts");
  }

  try {
    const { audioBuffer, voice: resolvedVoice, contentType } = await generateKokoroSpeech(
      textToSpeak,
      voiceId,
      speed
    );

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType || "audio/wav",
        "Content-Length": audioBuffer.byteLength.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "X-TTS-Provider": "kokoro",
        "X-TTS-Voice": resolvedVoice,
        ...rateLimitHeaders,
      },
    });
  } catch (err: unknown) {
    console.error("[TTS] Kokoro speech generation error:", (err as Error)?.message || err);
    const msg = err instanceof Error ? err.message : "An unexpected TTS error occurred.";
    const status =
      (err as any)?.status ||
      (msg.includes("timed out") ? 504 : msg.includes("must be a non-empty string") ? 400 : 502);

    return NextResponse.json(
      { error: msg },
      { status, headers: rateLimitHeaders }
    );
  } finally {
    slot.release();
  }
}
