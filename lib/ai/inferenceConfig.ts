/**
 * lib/ai/inferenceConfig.ts
 *
 * Centralized, server-only configuration for ULTRON remote/local AI inference services.
 * Governs communication from Vercel backend to private AI inference infrastructure:
 *   - Qwen3-8B (LLM)
 *   - Whisper large-v3-turbo (STT)
 *   - Kokoro-82M (TTS)
 *
 * Security Constraints:
 * 1. Server-to-server authentication via Bearer token (AI_INFERENCE_API_KEY).
 * 2. In production (NODE_ENV === "production"), AI_INFERENCE_API_KEY is strictly required.
 * 3. In local development, defaults to 127.0.0.1 endpoints without requiring secrets if absent.
 * 4. Never exposes secrets, internal URLs, or filesystem paths to browser bundles or responses.
 * 5. Prevents SSRF: endpoints are strictly resolved from server environment configuration.
 */

export type InferenceProvider = "qwen" | "whisper" | "kokoro";

export const DEFAULT_LOCAL_URLS: Record<InferenceProvider, string> = {
  qwen: "http://127.0.0.1:11434/v1",
  whisper: "http://127.0.0.1:8881/v1/audio/transcriptions",
  kokoro: "http://127.0.0.1:8880/v1/audio/speech",
};

export const DEFAULT_TIMEOUTS_MS: Record<InferenceProvider, number> = {
  qwen: 120_000,   // 120 seconds for complex generation / tool loops
  whisper: 20_000,  // 20 seconds for audio transcription
  kokoro: 30_000,   // 30 seconds for speech synthesis
};

export class InferenceConfigError extends Error {
  public statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = "InferenceConfigError";
    this.statusCode = statusCode;
  }
}

/**
 * Validates whether a given URL points to a local loopback address.
 */
export function isLocalhostAddress(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.startsWith("127.")
    );
  } catch {
    return false;
  }
}

/**
 * Validates whether a given hostname points to local loopback or private LAN address.
 * Identifies localhost, 127.x, 10.x, 192.168.x, 172.16-31.x, and 169.254.x.
 */
export function isPrivateOrLoopbackHost(hostStr: string): boolean {
  if (!hostStr) return false;
  const host = hostStr.toLowerCase().replace(/^\[|\]$/g, ""); // handle [::1]

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("127.")
  ) {
    return true;
  }

  // RFC 1918 Class A: 10.0.0.0 - 10.255.255.255
  if (host.startsWith("10.")) {
    return true;
  }

  // RFC 1918 Class C: 192.168.0.0 - 192.168.255.255
  if (host.startsWith("192.168.")) {
    return true;
  }

  // Link-local: 169.254.0.0 - 169.254.255.255
  if (host.startsWith("169.254.")) {
    return true;
  }

  // RFC 1918 Class B: 172.16.0.0 - 172.31.255.255
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const octet = parseInt(match172[1], 10);
    if (octet >= 16 && octet <= 31) {
      return true;
    }
  }

  return false;
}

/**
 * Returns whether the application is running in production mode.
 */
export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Retrieves the server-side AI inference API key.
 * In production, fails closed if missing.
 */
export function getInferenceApiKey(): string {
  const key = (process.env.AI_INFERENCE_API_KEY || "").trim();
  if (isProductionEnvironment() && !key) {
    throw new InferenceConfigError(
      "Secure production configuration error: AI_INFERENCE_API_KEY is not defined in server environment.",
      500
    );
  }
  return key;
}

/**
 * Resolves the unified remote inference gateway URL if defined.
 */
export function getUnifiedGatewayUrl(): string {
  return (process.env.AI_INFERENCE_URL || process.env.AI_INFERENCE_GATEWAY_URL || "").trim();
}

/**
 * Resolves the upstream endpoint for an inference provider.
 * Strictly respects server-side environment variables and prevents user-supplied URL overrides.
 *
 * Precedence:
 * 1. Provider-specific override (e.g. QWEN_INFERENCE_URL / QWEN_BASE_URL)
 * 2. Unified remote gateway base URL (AI_INFERENCE_URL / AI_INFERENCE_GATEWAY_URL)
 * 3. Default local development loopback URL (127.0.0.1:11434, 8881, 8880)
 *
 * Security Enforcement:
 * In production (NODE_ENV === "production"), endpoints MUST use HTTPS and cannot point to
 * localhost or private RFC1918 LAN addresses.
 */
export function getInferenceEndpoint(provider: InferenceProvider): string {
  let endpoint = "";

  // 1. Check provider-specific environment variables
  switch (provider) {
    case "qwen":
      endpoint = (process.env.QWEN_INFERENCE_URL || process.env.QWEN_BASE_URL || "").trim();
      break;
    case "whisper":
      endpoint = (process.env.WHISPER_INFERENCE_URL || process.env.WHISPER_API_URL || "").trim();
      break;
    case "kokoro":
      endpoint = (process.env.KOKORO_INFERENCE_URL || process.env.KOKORO_API_URL || "").trim();
      break;
  }

  // 2. If no provider-specific URL, check unified gateway base URL
  if (!endpoint) {
    const gatewayBase = getUnifiedGatewayUrl().replace(/\/+$/, "");
    if (gatewayBase) {
      const hasV1 = gatewayBase.endsWith("/v1");
      switch (provider) {
        case "qwen":
          endpoint = hasV1 ? gatewayBase : `${gatewayBase}/v1`;
          break;
        case "whisper":
          endpoint = hasV1
            ? `${gatewayBase}/audio/transcriptions`
            : `${gatewayBase}/v1/audio/transcriptions`;
          break;
        case "kokoro":
          endpoint = hasV1
            ? `${gatewayBase}/audio/speech`
            : `${gatewayBase}/v1/audio/speech`;
          break;
      }
    }
  }

  // 3. Fallback to default local loopback URL (for development)
  if (!endpoint) {
    endpoint = DEFAULT_LOCAL_URLS[provider];
  }

  // Ensure valid URL structure
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new InferenceConfigError(
      `Invalid server configuration: Endpoint for '${provider}' is not a valid URL.`,
      500
    );
  }

  // Enforce production security rules
  if (isProductionEnvironment()) {
    if (parsed.protocol !== "https:") {
      throw new InferenceConfigError(
        `Secure production configuration error: Endpoint for '${provider}' must use HTTPS in production. Received: ${parsed.protocol}//...`,
        500
      );
    }

    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      throw new InferenceConfigError(
        `Secure production configuration error: Endpoint for '${provider}' cannot point to local or private IP addresses (${parsed.hostname}) in production.`,
        500
      );
    }
  }

  return endpoint;
}

/**
 * Returns the chat completions full URL for Qwen.
 */
export function getQwenCompletionsUrl(): string {
  const base = getInferenceEndpoint("qwen").replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) {
    return base;
  }
  return `${base}/chat/completions`;
}

/**
 * Generates server-to-server authentication and protocol headers for upstream inference.
 * Never exposes the key to client components or responses.
 */
export function getInferenceAuthHeaders(
  provider: InferenceProvider,
  extraHeaders: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };
  const apiKey = getInferenceApiKey();

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  headers["X-Ultron-Client"] = "ultron-backend";
  headers["X-Inference-Provider"] = provider;

  return headers;
}

/**
 * Returns the finite execution timeout for an inference provider.
 */
export function getInferenceTimeoutMs(provider: InferenceProvider): number {
  return DEFAULT_TIMEOUTS_MS[provider] || 30_000;
}

export interface SanitizedInferenceError {
  statusCode: number;
  publicMessage: string;
  category: "auth" | "timeout" | "unavailable" | "upstream_error";
}

/**
 * Safely maps upstream inference failures into sanitized public HTTP responses.
 * NEVER leaks:
 *   - API keys / Authorization headers
 *   - Internal network IPs / URLs
 *   - Local filesystem paths
 *   - Raw upstream exception text / stack traces
 */
export function mapInferenceError(
  err: unknown,
  provider: InferenceProvider,
  upstreamStatus?: number
): SanitizedInferenceError {
  // 1. Upstream Authentication / Authorization Failure (401 or 403)
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return {
      statusCode: 502,
      publicMessage: `Inference gateway authentication error with upstream ${provider.toUpperCase()} service.`,
      category: "auth",
    };
  }

  // 2. Timeout (Gateway Timeout)
  const isTimeout =
    (err as Error)?.name === "TimeoutError" ||
    (err as Error)?.name === "AbortError" ||
    ((err as Error)?.message && (err as Error).message.toLowerCase().includes("timed out"));

  if (isTimeout) {
    return {
      statusCode: 504,
      publicMessage: `The ${provider.toUpperCase()} inference service timed out. Please try again.`,
      category: "timeout",
    };
  }

  // 3. Network Connection Failure / Service Unavailable (503)
  const msg = (err as Error)?.message || String(err || "");
  const isConnRefused =
    msg.includes("ECONNREFUSED") ||
    msg.includes("fetch failed") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("Connection refused");

  if (isConnRefused) {
    return {
      statusCode: 503,
      publicMessage: `The ${provider.toUpperCase()} inference service is currently unreachable or starting up.`,
      category: "unavailable",
    };
  }

  // 4. General upstream failure (502 Bad Gateway)
  return {
    statusCode: 502,
    publicMessage: `An unexpected response was received from the ${provider.toUpperCase()} inference service.`,
    category: "upstream_error",
  };
}
