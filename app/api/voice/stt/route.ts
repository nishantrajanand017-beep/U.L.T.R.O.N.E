import { NextResponse } from "next/server";
import { resolveUserSession } from "@/lib/auth/session";
import { transcribeAudioWithWhisper } from "@/lib/whisperService";
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
  validateSttPayload,
} from "@/lib/security/payloadValidators";

export async function POST(request: Request) {
  // 1. Same-Origin CSRF validation
  const originCheck = validateSameOrigin(request);
  if (!originCheck.valid && originCheck.errorResponse) {
    return originCheck.errorResponse;
  }

  // 2. Authentication check: STT requires verified user identity
  const { userId, isAuthenticated } = await resolveUserSession(request);
  if (!userId || !isAuthenticated) {
    return NextResponse.json(
      { error: "Unauthorized: Authentication required." },
      { status: 401 }
    );
  }

  // 3. Payload validation (audio file <= 10MB, supported audio MIME types)
  const payloadResult = await validateSttPayload(request);
  if (!payloadResult.success) {
    return payloadResult.errorResponse;
  }

  const { file, fileName } = payloadResult.data;

  // 4. Rate-limit check (BEFORE any expensive Whisper GPU/CPU inference)
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip");

  const testLimitHeader =
    process.env.NODE_ENV !== "production"
      ? parseInt(request.headers.get("x-test-rate-limit") || "0", 10) || undefined
      : undefined;

  const rateLimitResult = await checkEndpointRateLimit("stt", userId, clientIp, testLimitHeader);
  if (!rateLimitResult.allowed) {
    return createRateLimitErrorResponse(rateLimitResult);
  }

  const rateLimitHeaders = createRateLimitHeaders(rateLimitResult);

  // 5. Concurrency & backpressure protection
  const slot = acquireConcurrencySlot("stt");
  if (!slot.success) {
    return createConcurrencyErrorResponse("stt");
  }

  try {
    const result = await transcribeAudioWithWhisper(file, fileName);
    const text = result.text.trim();

    return NextResponse.json(
      { text },
      { headers: rateLimitHeaders }
    );
  } catch (err: unknown) {
    console.error("[STT] Error in /api/voice/stt:", (err as Error)?.message || err);
    const status = (err as any)?.status || 502;
    return NextResponse.json(
      { error: (err as Error)?.message || "Speech-to-text processing failed. Please try speaking again." },
      { status, headers: rateLimitHeaders }
    );
  } finally {
    slot.release();
  }
}
