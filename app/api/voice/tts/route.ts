import { NextResponse } from "next/server";

const DEFAULT_ASSISTANT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George (Resonant, authoritative, clear)

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

    let response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: textToSpeak,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    // If custom voice was not found (404), fallback to default voice
    if (response.status === 404 && voiceId !== DEFAULT_ASSISTANT_VOICE_ID) {
      console.warn(
        `[TTS] Voice '${voiceId}' not found (404). Retrying with default voice '${DEFAULT_ASSISTANT_VOICE_ID}'...`
      );
      voiceId = DEFAULT_ASSISTANT_VOICE_ID;
      response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: textToSpeak,
            model_id: modelId,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
        }
      );
    }

    console.log(`[TTS] ElevenLabs response status: ${response.status}`);

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

      return NextResponse.json(
        { error: `TTS failed: ${parsedMessage}` },
        { status: response.status }
      );
    }

    const audioBuffer = await response.arrayBuffer();
    console.log(
      `[TTS] Audio generation succeeded! Size=${audioBuffer.byteLength} bytes`
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
