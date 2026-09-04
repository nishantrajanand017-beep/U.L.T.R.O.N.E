import { NextResponse } from "next/server";

// Official ElevenLabs Premade Voices (100% Free-Tier API Eligible & Included in all plans)
// JBFqnCBsd6RMkjVDRZzb - George (Deep, authoritative, British/warm) - Default for ULTRON
// pNInz6obpgDQGcFmaJgB - Adam (Deep, clear narration, American)
// onwK4e9ZLuTAKqWW03F9 - Daniel (Authoritative, British)
// 21m00Tcm4TlvDq8ikWAM - Rachel (Calm, clear)
export const DEFAULT_ASSISTANT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George (Official Premade)
export const DEFAULT_ASSISTANT_VOICE_NAME = "George";

function resolveVoiceId(configuredId?: string | null): string {
  if (
    !configuredId ||
    configuredId === "YOUR_VOICE_ID" ||
    configuredId.includes("your_") ||
    configuredId.trim().length === 0
  ) {
    return DEFAULT_ASSISTANT_VOICE_ID;
  }
  return configuredId.trim();
}

async function requestElevenLabsTTS(
  apiKey: string,
  voiceId: string,
  modelId: string,
  text: string
): Promise<Response> {
  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    }
  );
}

function isVoiceRestrictionOrNotFoundError(status: number, errText: string): boolean {
  if (status === 404) return true;
  const lower = errText.toLowerCase();
  return (
    lower.includes("library voice") ||
    lower.includes("upgrade your subscription") ||
    lower.includes("voice_not_found") ||
    lower.includes("not_available_for_user") ||
    lower.includes("cannot use library") ||
    lower.includes("paid subscription") ||
    (status === 400 && lower.includes("voice")) ||
    (status === 403 && lower.includes("voice"))
  );
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "ELEVENLABS_API_KEY is not configured on the server. Please set it in .env.local.",
        },
        { status: 500 }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json(
        { error: "TTS failed: 'text' must be a non-empty string." },
        { status: 400 }
      );
    }

    const textToSpeak = body.text.trim();
    let voiceId = resolveVoiceId(process.env.ELEVENLABS_VOICE_ID);
    const modelId =
      process.env.ELEVENLABS_TTS_MODEL?.trim() || "eleven_flash_v2_5";

    console.log(
      `[TTS] Generating audio: voiceId=${voiceId}, modelId=${modelId}, textLength=${textToSpeak.length}`
    );

    let response = await requestElevenLabsTTS(
      apiKey,
      voiceId,
      modelId,
      textToSpeak
    );

    // If custom/configured voice is restricted (e.g. library voice on free tier) or not found, fallback to premade voice
    if (!response.ok && voiceId !== DEFAULT_ASSISTANT_VOICE_ID) {
      const errPeek = await response.clone().text().catch(() => "");
      if (isVoiceRestrictionOrNotFoundError(response.status, errPeek)) {
        console.warn(
          `[TTS] Configured voice '${voiceId}' is restricted on Free-tier API or not found (${response.status}). Automatically falling back to official Free-tier premade voice '${DEFAULT_ASSISTANT_VOICE_NAME}' (${DEFAULT_ASSISTANT_VOICE_ID})...`
        );
        voiceId = DEFAULT_ASSISTANT_VOICE_ID;
        response = await requestElevenLabsTTS(
          apiKey,
          voiceId,
          modelId,
          textToSpeak
        );
      }
    }

    console.log(`[TTS] ElevenLabs final response status: ${response.status}`);

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown TTS error");
      console.error(`[TTS] ElevenLabs error body:`, errText);

      let parsedMessage = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail?.message) {
          parsedMessage = parsed.detail.message;
        } else if (parsed.message) {
          parsedMessage = parsed.message;
        }
      } catch {
        // use raw errText
      }

      // Friendly diagnostics for common error conditions
      if (
        response.status === 401 ||
        parsedMessage.toLowerCase().includes("invalid_api_key")
      ) {
        return NextResponse.json(
          {
            error:
              "TTS failed: Invalid or unauthorized ELEVENLABS_API_KEY. Please verify your API key.",
          },
          { status: 401 }
        );
      }

      if (
        response.status === 429 ||
        parsedMessage.toLowerCase().includes("quota_exceeded") ||
        parsedMessage.toLowerCase().includes("credit_limit")
      ) {
        return NextResponse.json(
          {
            error:
              "TTS failed: ElevenLabs character quota limit reached for this billing period.",
          },
          { status: 429 }
        );
      }

      return NextResponse.json(
        { error: `TTS failed: ${parsedMessage}` },
        { status: response.status }
      );
    }

    const audioBuffer = await response.arrayBuffer();
    console.log(
      `[TTS] Audio generation succeeded! Size=${audioBuffer.byteLength} bytes (Voice: ${voiceId})`
    );

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err: unknown) {
    console.error("[TTS] Unexpected server error in /api/voice/tts:", err);
    const msg =
      err instanceof Error ? err.message : "An unexpected TTS error occurred.";
    return NextResponse.json({ error: `TTS failed: ${msg}` }, { status: 500 });
  }
}
