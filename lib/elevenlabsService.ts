export const DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George (Official Premade)
export const DEFAULT_ELEVENLABS_VOICE_NAME = "George";
export const DEFAULT_ELEVENLABS_MODEL = "eleven_flash_v2_5";

export interface ElevenLabsConfigInfo {
  isConfigured: boolean;
  status: "configured" | "not_configured" | "valid" | "invalid" | "error";
  voiceId: string;
  voiceName: string;
  modelId: string;
  lastTestedAt?: string | null;
  errorMessage?: string | null;
}

export interface ElevenLabsTestResult {
  valid: boolean;
  status: "valid" | "invalid" | "error" | "not_configured";
  message: string;
}

function resolveVoiceId(configuredId?: string | null): string {
  if (
    !configuredId ||
    configuredId === "YOUR_VOICE_ID" ||
    configuredId.includes("your_") ||
    configuredId.trim().length === 0
  ) {
    return DEFAULT_ELEVENLABS_VOICE_ID;
  }
  return configuredId.trim();
}

/**
 * Returns public, sanitized status of the ElevenLabs integration.
 * Never returns the raw API key.
 */
export function getElevenLabsPublicConfig(): ElevenLabsConfigInfo {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const isConfigured = Boolean(apiKey && apiKey.length > 0 && !apiKey.includes("your_"));
  const voiceId = resolveVoiceId(process.env.ELEVENLABS_VOICE_ID);
  const voiceName =
    voiceId === DEFAULT_ELEVENLABS_VOICE_ID ? DEFAULT_ELEVENLABS_VOICE_NAME : "Custom Voice";
  const modelId = process.env.ELEVENLABS_TTS_MODEL?.trim() || DEFAULT_ELEVENLABS_MODEL;

  return {
    isConfigured,
    status: isConfigured ? "configured" : "not_configured",
    voiceId,
    voiceName,
    modelId,
  };
}

/**
 * Tests connection to ElevenLabs without exposing API keys.
 */
export async function testElevenLabsConnection(): Promise<ElevenLabsTestResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey || apiKey.includes("your_")) {
    return {
      valid: false,
      status: "not_configured",
      message: "ELEVENLABS_API_KEY is not configured in server environment (.env.local).",
    };
  }

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": apiKey },
    });

    if (res.ok) {
      return {
        valid: true,
        status: "valid",
        message: "ElevenLabs connection verified. Voice synthesis active.",
      };
    }

    if (res.status === 401) {
      return {
        valid: false,
        status: "invalid",
        message: "Invalid or unauthorized ELEVENLABS_API_KEY.",
      };
    }

    if (res.status === 429) {
      return {
        valid: false,
        status: "error",
        message: "ElevenLabs API quota exceeded for current billing period.",
      };
    }

    return {
      valid: false,
      status: "error",
      message: `ElevenLabs verification returned HTTP ${res.status}.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Network error";
    return {
      valid: false,
      status: "error",
      message: `Failed to connect to ElevenLabs: ${msg}`,
    };
  }
}

/**
 * Executes a speech synthesis request against ElevenLabs.
 */
export async function generateElevenLabsSpeech(
  text: string,
  targetVoiceId?: string,
  targetModelId?: string
): Promise<{ audioBuffer: ArrayBuffer; voiceId: string }> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey || apiKey.includes("your_")) {
    throw new Error(
      "ELEVENLABS_API_KEY is not configured on the server. Please set it in .env.local."
    );
  }

  const trimmedText = text?.trim();
  if (!trimmedText) {
    throw new Error("TTS failed: Text must be a non-empty string.");
  }

  let voiceId = resolveVoiceId(targetVoiceId || process.env.ELEVENLABS_VOICE_ID);
  const modelId =
    targetModelId || process.env.ELEVENLABS_TTS_MODEL?.trim() || DEFAULT_ELEVENLABS_MODEL;

  const requestTTS = async (vId: string) => {
    return fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: trimmedText,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );
  };

  let response = await requestTTS(voiceId);

  // If custom/configured voice is restricted or not found, fallback to premade voice
  if (!response.ok && voiceId !== DEFAULT_ELEVENLABS_VOICE_ID) {
    const errPeek = await response.clone().text().catch(() => "");
    const lower = errPeek.toLowerCase();
    const isRestricted =
      response.status === 404 ||
      lower.includes("library voice") ||
      lower.includes("voice_not_found") ||
      lower.includes("subscription");

    if (isRestricted) {
      console.warn(
        `[TTS] Voice '${voiceId}' restricted/not found. Falling back to '${DEFAULT_ELEVENLABS_VOICE_NAME}' (${DEFAULT_ELEVENLABS_VOICE_ID})`
      );
      voiceId = DEFAULT_ELEVENLABS_VOICE_ID;
      response = await requestTTS(voiceId);
    }
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown TTS error");
    let parsedMessage = errText;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.detail?.message) parsedMessage = parsed.detail.message;
      else if (parsed.message) parsedMessage = parsed.message;
    } catch {
      // keep raw errText
    }

    if (response.status === 401 || parsedMessage.toLowerCase().includes("invalid_api_key")) {
      throw new Error("Invalid or unauthorized ELEVENLABS_API_KEY.");
    }
    if (response.status === 429 || parsedMessage.toLowerCase().includes("quota")) {
      throw new Error("ElevenLabs quota limit reached for this billing period.");
    }

    throw new Error(`TTS failed: ${parsedMessage}`);
  }

  const audioBuffer = await response.arrayBuffer();
  if (audioBuffer.byteLength === 0) {
    throw new Error("TTS returned 0 bytes of audio.");
  }

  return { audioBuffer, voiceId };
}
