import { NextResponse } from "next/server";

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

    const formData = await request.formData().catch((e) => {
      console.error("STT: Failed to parse form data:", e);
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

    // Server-side diagnostics (NEVER log API keys)
    console.log(
      `[STT] Processing audio upload: name=${fileName}, type=${mimeType}, size=${fileSize} bytes`
    );

    const elevenFormData = new FormData();
    elevenFormData.append("file", file, fileName);
    elevenFormData.append("model_id", "scribe_v2");

    const response = await fetch(
      "https://api.elevenlabs.io/v1/speech-to-text",
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
        },
        body: elevenFormData,
      }
    );

    console.log(`[STT] ElevenLabs response status: ${response.status}`);

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown STT error");
      console.error(`[STT] ElevenLabs error body:`, errText);

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
        { error: `STT failed: ${parsedMessage}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    const text = (data.text || "").trim();
    console.log(`[STT] Transcription succeeded (${text.length} chars): "${text}"`);

    return NextResponse.json({
      text,
    });
  } catch (err: unknown) {
    console.error("[STT] Unexpected server error in /api/voice/stt:", err);
    const msg =
      err instanceof Error ? err.message : "An unexpected STT error occurred.";
    return NextResponse.json({ error: `STT failed: ${msg}` }, { status: 500 });
  }
}
