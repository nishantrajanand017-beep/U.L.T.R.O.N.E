import {
  getInferenceEndpoint,
  getInferenceAuthHeaders,
  getInferenceTimeoutMs,
  mapInferenceError,
  DEFAULT_LOCAL_URLS,
} from "./ai/inferenceConfig";

export const DEFAULT_WHISPER_API_URL = DEFAULT_LOCAL_URLS.whisper;
export const DEFAULT_WHISPER_MODEL = "small";
export const DEFAULT_WHISPER_LANGUAGE = "en";

export interface WhisperTranscriptionOptions {
  model?: string;
  language?: string;
}

export interface WhisperTranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  inferenceTimeMs?: number;
}

/**
 * Transcribes audio via the local/private faster-whisper HTTP server.
 * This function runs strictly server-side and never exposes internal server URLs to the browser.
 */
export async function transcribeAudioWithWhisper(
  audioBlobOrBuffer: Blob | File | Buffer,
  fileName: string = "speech.webm",
  options?: WhisperTranscriptionOptions
): Promise<WhisperTranscriptionResult> {
  const apiUrl = getInferenceEndpoint("whisper");
  const model = options?.model || process.env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL;
  const language = options?.language || process.env.WHISPER_LANGUAGE || DEFAULT_WHISPER_LANGUAGE;
  const timeoutMs = getInferenceTimeoutMs("whisper");

  const formData = new FormData();

  if (Buffer.isBuffer(audioBlobOrBuffer)) {
    const blob = new Blob([new Uint8Array(audioBlobOrBuffer)], { type: "audio/webm" });
    formData.append("file", blob, fileName);
  } else {
    formData.append("file", audioBlobOrBuffer, fileName);
  }

  if (model) {
    formData.append("model", model);
  }
  if (language && language !== "auto") {
    formData.append("language", language);
  }

  const headers = getInferenceAuthHeaders("whisper");

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: formData,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    const mapped = mapInferenceError(err, "whisper");
    const error = new Error(mapped.publicMessage);
    (error as any).status = mapped.statusCode;
    throw error;
  }

  if (!response.ok) {
    const mapped = mapInferenceError(new Error("Upstream Whisper error"), "whisper", response.status);
    const error = new Error(mapped.publicMessage);
    (error as any).status = mapped.statusCode;
    throw error;
  }

  const data = await response.json().catch(() => null);
  if (!data) {
    const error = new Error("Received malformed or empty JSON from Whisper STT endpoint.");
    (error as any).status = 502;
    throw error;
  }

  const text = (data.text || "").trim();

  return {
    text,
    language: data.language,
    duration: data.duration,
    inferenceTimeMs: data.inference_time_ms,
  };
}
