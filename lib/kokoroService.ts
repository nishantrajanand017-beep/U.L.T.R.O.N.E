export const DEFAULT_KOKORO_API_URL = "http://127.0.0.1:8880/v1/audio/speech";
export const DEFAULT_KOKORO_VOICE = "am_adam";
export const DEFAULT_KOKORO_MODEL = "kokoro";
export const DEFAULT_KOKORO_SPEED = 1.0;

export interface KokoroSpeechResult {
  audioBuffer: ArrayBuffer;
  voice: string;
  contentType: string;
  durationSec?: number;
  inferenceTimeMs?: number;
}

/**
 * Generates speech audio using the local/private Kokoro-82M HTTP server.
 * This function must only be called server-side and never exposes the internal URL to the browser.
 */
export async function generateKokoroSpeech(
  text: string,
  targetVoice?: string,
  targetSpeed?: number
): Promise<KokoroSpeechResult> {
  const trimmedText = text?.trim();
  if (!trimmedText) {
    throw new Error("TTS failed: Text must be a non-empty string.");
  }

  const apiUrl = (process.env.KOKORO_API_URL || DEFAULT_KOKORO_API_URL).trim();
  const voice = targetVoice?.trim() || process.env.KOKORO_VOICE?.trim() || DEFAULT_KOKORO_VOICE;
  const speed =
    typeof targetSpeed === "number" && !isNaN(targetSpeed) && targetSpeed > 0
      ? targetSpeed
      : parseFloat(process.env.KOKORO_SPEED || "1.0") || DEFAULT_KOKORO_SPEED;

  const payload = {
    model: DEFAULT_KOKORO_MODEL,
    input: trimmedText,
    voice: voice,
    response_format: "wav",
    speed: speed,
  };

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/wav",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000), // 20-second timeout guard
    });
  } catch (err: unknown) {
    const isTimeout = (err as Error)?.name === "TimeoutError";
    const msg = isTimeout
      ? "Kokoro TTS service timed out after 20 seconds."
      : `Failed to connect to Kokoro TTS server at internal endpoint: ${(err as Error)?.message || "Connection refused"}`;
    throw new Error(msg);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown Kokoro error");
    throw new Error(`Kokoro TTS synthesis failed (HTTP ${response.status}): ${errText}`);
  }

  const contentType = response.headers.get("content-type") || "audio/wav";
  const audioBuffer = await response.arrayBuffer();

  if (audioBuffer.byteLength === 0) {
    throw new Error("Kokoro TTS returned 0 bytes of audio.");
  }

  const inferTimeHeader = response.headers.get("x-inference-time-ms");
  const durationHeader = response.headers.get("x-audio-duration-sec");

  return {
    audioBuffer,
    voice,
    contentType: "audio/wav",
    inferenceTimeMs: inferTimeHeader ? parseFloat(inferTimeHeader) : undefined,
    durationSec: durationHeader ? parseFloat(durationHeader) : undefined,
  };
}
