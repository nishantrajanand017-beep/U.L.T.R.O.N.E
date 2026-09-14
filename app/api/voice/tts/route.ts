import { NextResponse } from "next/server";
import {
  generateKokoroSpeech,
  DEFAULT_KOKORO_VOICE,
} from "@/lib/kokoroService";
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_VOICE_NAME,
} from "@/lib/elevenlabsService";

// Retain backwards compatibility for existing imports
export { DEFAULT_ELEVENLABS_VOICE_ID, DEFAULT_ELEVENLABS_VOICE_NAME, DEFAULT_KOKORO_VOICE };

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json(
        { error: "TTS failed: 'text' must be a non-empty string." },
        { status: 400 }
      );
    }

    const textToSpeak = body.text.trim();
    const voice = typeof body.voiceId === "string" && body.voiceId.trim() ? body.voiceId.trim() : undefined;
    const speed = typeof body.speed === "number" ? body.speed : undefined;

    const { audioBuffer, voice: resolvedVoice, contentType } = await generateKokoroSpeech(
      textToSpeak,
      voice,
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
      },
    });
  } catch (err: unknown) {
    console.error("[TTS] Kokoro speech generation error:", err);
    const msg = err instanceof Error ? err.message : "An unexpected TTS error occurred.";

    if (msg.includes("must be a non-empty string")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    if (msg.includes("timed out")) {
      return NextResponse.json({ error: msg }, { status: 504 });
    }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

