/**
 * scripts/test-phase8e-inference-security.ts
 *
 * Comprehensive Automated Test Suite for ULTRON Part 8E:
 * Remote Inference Security & Production AI Gateway.
 *
 * Deterministic test suite covering all 24 required security aspects:
 *  1. Qwen server configuration
 *  2. Whisper server configuration
 *  3. Kokoro server configuration
 *  4. Production requires inference secret
 *  5. Local development compatibility
 *  6. Qwen authentication header
 *  7. Whisper authentication header
 *  8. Kokoro authentication header
 *  9. Browser cannot override Qwen URL
 * 10. Browser cannot override Whisper URL
 * 11. Browser cannot override Kokoro URL
 * 12. SSRF-style override rejection
 * 13. Qwen timeout
 * 14. Whisper timeout
 * 15. Kokoro timeout
 * 16. Upstream 401 mapping
 * 17. Upstream 403 mapping
 * 18. Upstream timeout mapping
 * 19. Upstream unavailable mapping
 * 20. Upstream error sanitization
 * 21. No secret leakage
 * 22. No private URL leakage
 * 23. Health response sanitization
 * 24. Production missing-secret fail-closed behavior
 */

import assert from "node:assert/strict";
import {
  getInferenceApiKey,
  getInferenceEndpoint,
  getQwenCompletionsUrl,
  getInferenceAuthHeaders,
  getInferenceTimeoutMs,
  mapInferenceError,
  DEFAULT_LOCAL_URLS,
  DEFAULT_TIMEOUTS_MS,
  InferenceConfigError,
} from "../lib/ai/inferenceConfig";
import { checkInferenceHealth, checkProviderHealth } from "../lib/ai/inferenceHealth";
import { generateQwenResponse } from "../lib/qwenService";
import { transcribeAudioWithWhisper } from "../lib/whisperService";
import { generateKokoroSpeech } from "../lib/kokoroService";

let totalPassed = 0;
let totalFailed = 0;

function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      totalPassed++;
      console.log(`  [PASS] Test ${totalPassed + totalFailed}: ${name}`);
    })
    .catch((err) => {
      totalFailed++;
      console.error(`  [FAIL] Test ${totalPassed + totalFailed}: ${name}`);
      console.error(`         Reason: ${(err as Error)?.message || err}`);
    });
}

async function main() {
  console.log("\n=======================================================");
  console.log("  PART 8E — REMOTE INFERENCE SECURITY & AI GATEWAY TEST");
  console.log("=======================================================\n");

  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  try {
    // -------------------------------------------------------------
    // 1. Qwen server configuration
    // -------------------------------------------------------------
    await runTest("1. Qwen server configuration resolution", () => {
      process.env.QWEN_INFERENCE_URL = "https://ai-remote.example.com/v1";
      const endpoint = getInferenceEndpoint("qwen");
      assert.equal(endpoint, "https://ai-remote.example.com/v1");

      const completionsUrl = getQwenCompletionsUrl();
      assert.equal(completionsUrl, "https://ai-remote.example.com/v1/chat/completions");
    });

    // -------------------------------------------------------------
    // 2. Whisper server configuration
    // -------------------------------------------------------------
    await runTest("2. Whisper server configuration resolution", () => {
      process.env.WHISPER_INFERENCE_URL = "https://ai-remote.example.com/v1/audio/transcriptions";
      const endpoint = getInferenceEndpoint("whisper");
      assert.equal(endpoint, "https://ai-remote.example.com/v1/audio/transcriptions");
    });

    // -------------------------------------------------------------
    // 3. Kokoro server configuration
    // -------------------------------------------------------------
    await runTest("3. Kokoro server configuration resolution", () => {
      process.env.KOKORO_INFERENCE_URL = "https://ai-remote.example.com/v1/audio/speech";
      const endpoint = getInferenceEndpoint("kokoro");
      assert.equal(endpoint, "https://ai-remote.example.com/v1/audio/speech");
    });

    // -------------------------------------------------------------
    // 4. Production requires inference secret
    // -------------------------------------------------------------
    await runTest("4. Production requires inference secret", () => {
      (process.env as any).NODE_ENV = "production";
      delete process.env.AI_INFERENCE_API_KEY;

      assert.throws(
        () => getInferenceApiKey(),
        (err: any) => {
          assert.ok(err instanceof InferenceConfigError);
          assert.match(err.message, /AI_INFERENCE_API_KEY is not defined/);
          return true;
        }
      );
    });

    // -------------------------------------------------------------
    // 5. Local development compatibility
    // -------------------------------------------------------------
    await runTest("5. Local development compatibility without mandatory key", () => {
      (process.env as any).NODE_ENV = "development";
      delete process.env.AI_INFERENCE_API_KEY;
      delete process.env.QWEN_INFERENCE_URL;
      delete process.env.QWEN_BASE_URL;
      delete process.env.WHISPER_INFERENCE_URL;
      delete process.env.WHISPER_API_URL;
      delete process.env.KOKORO_INFERENCE_URL;
      delete process.env.KOKORO_API_URL;

      const key = getInferenceApiKey();
      assert.equal(key, "");

      assert.equal(getInferenceEndpoint("qwen"), DEFAULT_LOCAL_URLS.qwen);
      assert.equal(getInferenceEndpoint("whisper"), DEFAULT_LOCAL_URLS.whisper);
      assert.equal(getInferenceEndpoint("kokoro"), DEFAULT_LOCAL_URLS.kokoro);
    });

    // -------------------------------------------------------------
    // 6. Qwen authentication header
    // -------------------------------------------------------------
    await runTest("6. Qwen authentication header generation", () => {
      process.env.AI_INFERENCE_API_KEY = "test-secret-key-12345";
      const headers = getInferenceAuthHeaders("qwen");

      assert.equal(headers["Authorization"], "Bearer test-secret-key-12345");
      assert.equal(headers["X-Ultron-Client"], "ultron-backend");
      assert.equal(headers["X-Inference-Provider"], "qwen");
    });

    // -------------------------------------------------------------
    // 7. Whisper authentication header
    // -------------------------------------------------------------
    await runTest("7. Whisper authentication header generation", () => {
      process.env.AI_INFERENCE_API_KEY = "test-secret-key-12345";
      const headers = getInferenceAuthHeaders("whisper");

      assert.equal(headers["Authorization"], "Bearer test-secret-key-12345");
      assert.equal(headers["X-Ultron-Client"], "ultron-backend");
      assert.equal(headers["X-Inference-Provider"], "whisper");
    });

    // -------------------------------------------------------------
    // 8. Kokoro authentication header
    // -------------------------------------------------------------
    await runTest("8. Kokoro authentication header generation", () => {
      process.env.AI_INFERENCE_API_KEY = "test-secret-key-12345";
      const headers = getInferenceAuthHeaders("kokoro");

      assert.equal(headers["Authorization"], "Bearer test-secret-key-12345");
      assert.equal(headers["X-Ultron-Client"], "ultron-backend");
      assert.equal(headers["X-Inference-Provider"], "kokoro");
    });

    // -------------------------------------------------------------
    // 9. Browser cannot override Qwen URL
    // -------------------------------------------------------------
    await runTest("9. Browser cannot override Qwen URL", async () => {
      process.env.QWEN_INFERENCE_URL = "https://trusted-ai-cluster.internal/v1";
      process.env.AI_INFERENCE_API_KEY = "sec-key";

      let capturedUrl = "";
      global.fetch = (async (url: string | URL | Request) => {
        capturedUrl = url.toString();
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Test response", role: "assistant" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      // Caller attempts to pass malicious user input or simulated override
      await generateQwenResponse("Test prompt with http://evil.com/override");

      assert.equal(capturedUrl, "https://trusted-ai-cluster.internal/v1/chat/completions");
      assert.ok(!capturedUrl.includes("evil.com"));
    });

    // -------------------------------------------------------------
    // 10. Browser cannot override Whisper URL
    // -------------------------------------------------------------
    await runTest("10. Browser cannot override Whisper URL", async () => {
      process.env.WHISPER_INFERENCE_URL = "https://trusted-whisper.internal/v1/audio/transcriptions";
      process.env.AI_INFERENCE_API_KEY = "sec-key";

      let capturedUrl = "";
      global.fetch = (async (url: string | URL | Request) => {
        capturedUrl = url.toString();
        return new Response(
          JSON.stringify({ text: "Transcribed speech", language: "en" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      await transcribeAudioWithWhisper(Buffer.from("fake-audio-bytes"));

      assert.equal(capturedUrl, "https://trusted-whisper.internal/v1/audio/transcriptions");
    });

    // -------------------------------------------------------------
    // 11. Browser cannot override Kokoro URL
    // -------------------------------------------------------------
    await runTest("11. Browser cannot override Kokoro URL", async () => {
      process.env.KOKORO_INFERENCE_URL = "https://trusted-kokoro.internal/v1/audio/speech";
      process.env.AI_INFERENCE_API_KEY = "sec-key";

      let capturedUrl = "";
      global.fetch = (async (url: string | URL | Request) => {
        capturedUrl = url.toString();
        return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00]), {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        });
      }) as typeof fetch;

      await generateKokoroSpeech("Hello world");

      assert.equal(capturedUrl, "https://trusted-kokoro.internal/v1/audio/speech");
    });

    // -------------------------------------------------------------
    // 12. SSRF-style override rejection
    // -------------------------------------------------------------
    await runTest("12. SSRF-style override rejection", () => {
      // Endpoints are not derived from user input; invalid environment values are rejected
      const prev = process.env.QWEN_INFERENCE_URL;
      process.env.QWEN_INFERENCE_URL = "not-a-valid-url";
      try {
        assert.throws(
          () => getInferenceEndpoint("qwen"),
          (err: any) => {
            assert.ok(err instanceof InferenceConfigError);
            assert.match(err.message, /not a valid URL/);
            return true;
          }
        );
      } finally {
        if (prev !== undefined) {
          process.env.QWEN_INFERENCE_URL = prev;
        } else {
          delete process.env.QWEN_INFERENCE_URL;
        }
      }
    });

    // -------------------------------------------------------------
    // 13. Qwen timeout
    // -------------------------------------------------------------
    await runTest("13. Qwen timeout is bounded to 120s", () => {
      assert.equal(getInferenceTimeoutMs("qwen"), DEFAULT_TIMEOUTS_MS.qwen);
      assert.equal(DEFAULT_TIMEOUTS_MS.qwen, 120_000);
    });

    // -------------------------------------------------------------
    // 14. Whisper timeout
    // -------------------------------------------------------------
    await runTest("14. Whisper timeout is bounded to 20s", () => {
      assert.equal(getInferenceTimeoutMs("whisper"), DEFAULT_TIMEOUTS_MS.whisper);
      assert.equal(DEFAULT_TIMEOUTS_MS.whisper, 20_000);
    });

    // -------------------------------------------------------------
    // 15. Kokoro timeout
    // -------------------------------------------------------------
    await runTest("15. Kokoro timeout is bounded to 30s", () => {
      assert.equal(getInferenceTimeoutMs("kokoro"), DEFAULT_TIMEOUTS_MS.kokoro);
      assert.equal(DEFAULT_TIMEOUTS_MS.kokoro, 30_000);
    });

    // -------------------------------------------------------------
    // 16. Upstream 401 mapping
    // -------------------------------------------------------------
    await runTest("16. Upstream 401 mapping to 502 Bad Gateway", () => {
      const sanitized = mapInferenceError(new Error("Unauthorized"), "qwen", 401);
      assert.equal(sanitized.statusCode, 502);
      assert.equal(sanitized.category, "auth");
      assert.match(sanitized.publicMessage, /gateway authentication error/i);
      assert.ok(!sanitized.publicMessage.includes("secret"));
    });

    // -------------------------------------------------------------
    // 17. Upstream 403 mapping
    // -------------------------------------------------------------
    await runTest("17. Upstream 403 mapping to 502 Bad Gateway", () => {
      const sanitized = mapInferenceError(new Error("Forbidden"), "whisper", 403);
      assert.equal(sanitized.statusCode, 502);
      assert.equal(sanitized.category, "auth");
      assert.match(sanitized.publicMessage, /gateway authentication error/i);
    });

    // -------------------------------------------------------------
    // 18. Upstream timeout mapping
    // -------------------------------------------------------------
    await runTest("18. Upstream timeout mapping to 504 Gateway Timeout", () => {
      const abortError = new Error("The operation was aborted due to timeout");
      abortError.name = "TimeoutError";

      const sanitized = mapInferenceError(abortError, "kokoro");
      assert.equal(sanitized.statusCode, 504);
      assert.equal(sanitized.category, "timeout");
      assert.match(sanitized.publicMessage, /timed out/i);
    });

    // -------------------------------------------------------------
    // 19. Upstream unavailable mapping
    // -------------------------------------------------------------
    await runTest("19. Upstream unavailable mapping to 503 Service Unavailable", () => {
      const connRefused = new Error("connect ECONNREFUSED 127.0.0.1:8880");
      const sanitized = mapInferenceError(connRefused, "kokoro");

      assert.equal(sanitized.statusCode, 503);
      assert.equal(sanitized.category, "unavailable");
      assert.match(sanitized.publicMessage, /unreachable or starting up/i);
    });

    // -------------------------------------------------------------
    // 20. Upstream error sanitization
    // -------------------------------------------------------------
    await runTest("20. Upstream error sanitization hides sensitive details", () => {
      const sensitiveError = new Error(
        "Traceback (most recent call last): File /app/internal/model.py line 42 in load_weights: Permission denied /etc/secrets/ai_key"
      );
      const sanitized = mapInferenceError(sensitiveError, "qwen");

      assert.equal(sanitized.statusCode, 502);
      assert.ok(!sanitized.publicMessage.includes("Traceback"));
      assert.ok(!sanitized.publicMessage.includes("/app/internal"));
      assert.ok(!sanitized.publicMessage.includes("/etc/secrets"));
      assert.match(sanitized.publicMessage, /unexpected response was received/i);
    });

    // -------------------------------------------------------------
    // 21. No secret leakage
    // -------------------------------------------------------------
    await runTest("21. No secret leakage in error responses or headers representation", () => {
      const secret = "SUPER_SECRET_PRODUCTION_INFERENCE_KEY_999";
      process.env.AI_INFERENCE_API_KEY = secret;

      const headers = getInferenceAuthHeaders("qwen");
      assert.equal(headers["Authorization"], `Bearer ${secret}`);

      // Errors mapped must NEVER contain the secret
      const err = new Error(`Connection failed with key ${secret}`);
      const sanitized = mapInferenceError(err, "qwen");

      assert.ok(!sanitized.publicMessage.includes(secret));
    });

    // -------------------------------------------------------------
    // 22. No private URL leakage
    // -------------------------------------------------------------
    await runTest("22. No private URL leakage in public error messages", () => {
      const privateIpError = new Error("connect to http://10.240.0.42:8080/v1 failed");
      const sanitized = mapInferenceError(privateIpError, "whisper");

      assert.ok(!sanitized.publicMessage.includes("10.240.0.42"));
      assert.ok(!sanitized.publicMessage.includes("http://"));
    });

    // -------------------------------------------------------------
    // 23. Health response sanitization
    // -------------------------------------------------------------
    await runTest("23. Health response sanitization returns safe diagnostic summary", async () => {
      global.fetch = (async () => {
        return new Response("OK", { status: 200 });
      }) as typeof fetch;

      const health = await checkInferenceHealth();

      assert.ok(health.qwen === "healthy" || health.qwen === "unavailable");
      assert.ok(health.whisper === "healthy" || health.whisper === "unavailable");
      assert.ok(health.kokoro === "healthy" || health.kokoro === "unavailable");
      assert.ok(typeof health.timestamp === "string");

      const jsonString = JSON.stringify(health);
      assert.ok(!jsonString.includes("Bearer"));
      assert.ok(!jsonString.includes("http"));
      assert.ok(!jsonString.includes("127.0.0.1"));
    });

    // -------------------------------------------------------------
    // 24. Production missing-secret fail-closed behavior
    // -------------------------------------------------------------
    await runTest("24. Production missing-secret fail-closed behavior", async () => {
      (process.env as any).NODE_ENV = "production";
      delete process.env.AI_INFERENCE_API_KEY;
      process.env.QWEN_INFERENCE_URL = "https://ai-remote.example.com/v1";
      process.env.WHISPER_INFERENCE_URL = "https://ai-remote.example.com/v1/audio/transcriptions";
      process.env.KOKORO_INFERENCE_URL = "https://ai-remote.example.com/v1/audio/speech";

      // Any attempt to generate headers or run inference in production without secret must immediately throw
      let threwQwen = false;
      try {
        await generateQwenResponse("test");
      } catch (err: any) {
        threwQwen = true;
        assert.match(err.message, /AI_INFERENCE_API_KEY is not defined/);
      }
      assert.ok(threwQwen, "Qwen must fail closed in production when AI_INFERENCE_API_KEY is missing");

      let threwWhisper = false;
      try {
        await transcribeAudioWithWhisper(Buffer.from("dummy"));
      } catch (err: any) {
        threwWhisper = true;
        assert.match(err.message, /AI_INFERENCE_API_KEY is not defined/);
      }
      assert.ok(threwWhisper, "Whisper must fail closed in production when AI_INFERENCE_API_KEY is missing");

      let threwKokoro = false;
      try {
        await generateKokoroSpeech("test speech");
      } catch (err: any) {
        threwKokoro = true;
        assert.match(err.message, /AI_INFERENCE_API_KEY is not defined/);
      }
      assert.ok(threwKokoro, "Kokoro must fail closed in production when AI_INFERENCE_API_KEY is missing");
    });
  } finally {
    // Restore environment and fetch
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    global.fetch = originalFetch;
  }

  console.log("\n-------------------------------------------------------");
  console.log(`Results: ${totalPassed} passed, ${totalFailed} failed (Total: ${totalPassed + totalFailed})`);
  console.log("-------------------------------------------------------\n");

  if (totalFailed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
