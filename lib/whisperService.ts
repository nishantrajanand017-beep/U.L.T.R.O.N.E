export const DEFAULT_WHISPER_API_URL = "http://127.0.0.1:8881/v1/audio/transcriptions";
export const DEFAULT_WHISPER_MODEL = "large-v3-turbo";
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
  const apiUrl = (process.env.WHISPER_API_URL || DEFAULT_WHISPER_API_URL).trim();
  const model = options?.model || process.env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL;
  const language = options?.language || process.env.WHISPER_LANGUAGE || DEFAULT_WHISPER_LANGUAGE;

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

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(20000), // 20-second timeout guard
    });
  } catch (err: unknown) {
    const isTimeout = (err as Error)?.name === "TimeoutError";
    const msg = isTimeout
      ? "Whisper STT service timed out after 20 seconds."
      : `Failed to connect to local Whisper STT server at internal endpoint: ${(err as Error)?.message || "Connection refused"}`;
    const error = new Error(msg);
    (error as any).status = 503;
    throw error;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown upstream STT error");
    let parsedMessage = errText;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.detail) {
        parsedMessage = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
      }
    } catch {
      // keep raw errText
    }
    const error = new Error(`Whisper STT failed: ${parsedMessage}`);
    (error as any).status = response.status >= 500 ? 502 : response.status;
    throw error;
  }

  const data = await response.json();
  const text = (data.text || "").trim();

  return {
    text,
    language: data.language,
    duration: data.duration,
    inferenceTimeMs: data.inference_time_ms,
  };
}
