import {
  getInferenceEndpoint,
  getInferenceAuthHeaders,
  getInferenceTimeoutMs,
  mapInferenceError,
  DEFAULT_LOCAL_URLS,
} from "./ai/inferenceConfig";

export const DEFAULT_KOKORO_API_URL = DEFAULT_LOCAL_URLS.kokoro;
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
    const err = new Error("TTS failed: Text must be a non-empty string.");
    (err as any).status = 400;
    throw err;
  }

  const apiUrl = getInferenceEndpoint("kokoro");
  const voice = targetVoice?.trim() || process.env.KOKORO_VOICE?.trim() || DEFAULT_KOKORO_VOICE;
  const speed =
    typeof targetSpeed === "number" && !isNaN(targetSpeed) && targetSpeed > 0
      ? targetSpeed
      : parseFloat(process.env.KOKORO_SPEED || "1.0") || DEFAULT_KOKORO_SPEED;
  const timeoutMs = getInferenceTimeoutMs("kokoro");

  const payload = {
    model: DEFAULT_KOKORO_MODEL,
    input: trimmedText,
    voice: voice,
    response_format: "wav",
    speed: speed,
  };

  const headers = getInferenceAuthHeaders("kokoro", {
    "Content-Type": "application/json",
    Accept: "audio/wav",
  });

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    const mapped = mapInferenceError(err, "kokoro");
    const error = new Error(mapped.publicMessage);
    (error as any).status = mapped.statusCode;
    throw error;
  }

  if (!response.ok) {
    const mapped = mapInferenceError(new Error("Upstream Kokoro error"), "kokoro", response.status);
    const error = new Error(mapped.publicMessage);
    (error as any).status = mapped.statusCode;
    throw error;
  }

  const contentType = response.headers.get("content-type") || "audio/wav";
  const audioBuffer = await response.arrayBuffer();

  if (audioBuffer.byteLength === 0) {
    const error = new Error("Kokoro TTS returned 0 bytes of audio.");
    (error as any).status = 502;
    throw error;
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
