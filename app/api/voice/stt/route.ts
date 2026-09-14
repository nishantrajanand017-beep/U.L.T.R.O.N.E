import { NextResponse } from "next/server";
import { transcribeAudioWithWhisper } from "@/lib/whisperService";

export async function POST(request: Request) {
  try {
    const formData = await request.formData().catch((e) => {
      console.error("[STT] Failed to parse form data:", e);
      return null;
    });

    if (!formData) {
      return NextResponse.json(
        { error: "STT failed: Invalid form data in request." },
        { status: 400 }
      );
    }

    const file = formData.get("file") as Blob | File | null;
    if (!file || (file instanceof Blob && file.size === 0)) {
      return NextResponse.json(
        { error: "STT failed: Missing or empty audio file in form data." },
        { status: 400 }
      );
    }

    const fileName =
      file instanceof File && file.name ? file.name : "speech.webm";
    const mimeType = file.type || "audio/webm";
    const fileSize = file.size;

    console.log(
      `[STT] Processing audio upload with local Whisper: name=${fileName}, type=${mimeType}, size=${fileSize} bytes`
    );

    const result = await transcribeAudioWithWhisper(file, fileName);
    const text = result.text.trim();

    console.log(`[STT] Whisper transcription succeeded (${text.length} chars): "${text}"`);

    return NextResponse.json({
      text,
    });
  } catch (err: unknown) {
    console.error("[STT] Error in /api/voice/stt:", err);
    const msg =
      err instanceof Error ? err.message : "An unexpected STT error occurred.";
    const status = (err as any)?.status || 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
