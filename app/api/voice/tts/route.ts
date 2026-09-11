import { NextResponse } from "next/server";
import {
  generateElevenLabsSpeech,
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_VOICE_NAME,
} from "@/lib/elevenlabsService";

export { DEFAULT_ELEVENLABS_VOICE_ID, DEFAULT_ELEVENLABS_VOICE_NAME };

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
    const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : undefined;
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : undefined;

    const { audioBuffer, voiceId: resolvedVoiceId } = await generateElevenLabsSpeech(
      textToSpeak,
      voiceId,
      modelId
    );

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBuffer.byteLength.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "X-ElevenLabs-Voice": resolvedVoiceId,
      },
    });
  } catch (err: unknown) {
    console.error("[TTS] ElevenLabs speech generation error:", err);
    const msg = err instanceof Error ? err.message : "An unexpected TTS error occurred.";

    if (msg.includes("ELEVENLABS_API_KEY is not configured")) {
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    if (msg.includes("Invalid or unauthorized ELEVENLABS_API_KEY")) {
      return NextResponse.json({ error: msg }, { status: 401 });
    }
    if (msg.includes("quota limit reached")) {
      return NextResponse.json({ error: msg }, { status: 429 });
    }
    if (msg.includes("Text must be a non-empty string")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

