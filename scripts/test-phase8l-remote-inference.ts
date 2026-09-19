/**
 * scripts/test-phase8l-remote-inference.ts
 *
 * Comprehensive Automated Test Suite for ULTRON Part 8L:
 * Connect Vercel ULTRON to Remote Inference Gateway.
 *
 * Deterministic test suite verifying all 15 required security & architectural aspects:
 *  1. Production remote gateway URL is accepted.
 *  2. Production requires HTTPS.
 *  3. Localhost/local IP remains allowed ONLY in development.
 *  4. AI_INFERENCE_API_KEY is attached server-side.
 *  5. AI_INFERENCE_API_KEY is never exposed to client code.
 *  6. MODEL_INTERNAL_API_KEY is absent from the ULTRON project.
 *  7. Browser cannot override inference URL.
 *  8. Chat uses gateway chat path (/v1/chat/completions).
 *  9. STT uses gateway transcription path (/v1/audio/transcriptions).
 * 10. TTS uses gateway speech path (/v1/audio/speech).
 * 11. Correct provider header is sent (X-Inference-Provider & X-Ultron-Client).
 * 12. Upstream 401/403 -> sanitized error (502).
 * 13. Timeout -> 504.
 * 14. Unreachable gateway -> 503.
 * 15. Unexpected upstream failure -> 502.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  getInferenceApiKey,
  getInferenceEndpoint,
  getQwenCompletionsUrl,
  getInferenceAuthHeaders,
  getUnifiedGatewayUrl,
  isPrivateOrLoopbackHost,
  isLocalhostAddress,
  mapInferenceError,
  DEFAULT_LOCAL_URLS,
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
  console.log("  PART 8L — VERCEL ULTRON REMOTE INFERENCE GATEWAY TEST");
  console.log("=======================================================\n");

  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  try {
    // -------------------------------------------------------------
    // 1. Production remote gateway URL is accepted
    // -------------------------------------------------------------
    await runTest("1. Production remote gateway URL is accepted via AI_INFERENCE_URL", () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AI_INFERENCE_URL = "https://ai-gateway.example.com";
      process.env.AI_INFERENCE_API_KEY = "test-prod-key-12345";
      delete process.env.QWEN_INFERENCE_URL;
      delete process.env.QWEN_BASE_URL;
      delete process.env.WHISPER_INFERENCE_URL;
      delete process.env.WHISPER_API_URL;
      delete process.env.KOKORO_INFERENCE_URL;
      delete process.env.KOKORO_API_URL;

      assert.equal(getUnifiedGatewayUrl(), "https://ai-gateway.example.com");
      assert.equal(getInferenceEndpoint("qwen"), "https://ai-gateway.example.com/v1");
      assert.equal(getInferenceEndpoint("whisper"), "https://ai-gateway.example.com/v1/audio/transcriptions");
      assert.equal(getInferenceEndpoint("kokoro"), "https://ai-gateway.example.com/v1/audio/speech");
    });

    // -------------------------------------------------------------
    // 2. Production requires HTTPS
    // -------------------------------------------------------------
    await runTest("2. Production strictly requires HTTPS for inference gateway", () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AI_INFERENCE_API_KEY = "test-prod-key";
      process.env.AI_INFERENCE_URL = "http://insecure-gateway.example.com";
      delete process.env.QWEN_INFERENCE_URL;
      delete process.env.WHISPER_INFERENCE_URL;
      delete process.env.KOKORO_INFERENCE_URL;

      assert.throws(
        () => getInferenceEndpoint("qwen"),
        (err: any) => {
          assert.ok(err instanceof InferenceConfigError);
          assert.match(err.message, /must use HTTPS in production/i);
          return true;
        }
      );
    });

    // -------------------------------------------------------------
    // 3. Localhost/local IP remains allowed ONLY in development
    // -------------------------------------------------------------
    await runTest("3. Localhost and private LAN IPs allowed in dev, rejected in production", () => {
      // In development: localhost and 127.0.0.1 work smoothly
      (process.env as any).NODE_ENV = "development";
      delete process.env.AI_INFERENCE_URL;
      delete process.env.QWEN_INFERENCE_URL;
      delete process.env.WHISPER_INFERENCE_URL;
      delete process.env.KOKORO_INFERENCE_URL;

      const devEndpoint = getInferenceEndpoint("qwen");
      assert.equal(devEndpoint, DEFAULT_LOCAL_URLS.qwen);
      assert.ok(isLocalhostAddress(devEndpoint));

      // In production: localhost and private IPs are rejected
      (process.env as any).NODE_ENV = "production";
      process.env.AI_INFERENCE_API_KEY = "test-prod-key";

      const forbiddenHosts = [
        "https://127.0.0.1:8890",
        "https://localhost:8890",
        "https://192.168.1.100:8890",
        "https://10.0.1.50:8890",
        "https://172.16.5.20:8890",
        "https://172.31.255.1:8890",
        "https://169.254.1.1:8890",
      ];

      for (const forbiddenUrl of forbiddenHosts) {
        process.env.AI_INFERENCE_URL = forbiddenUrl;
        assert.throws(
          () => getInferenceEndpoint("qwen"),
          (err: any) => {
            assert.ok(err instanceof InferenceConfigError);
            assert.match(err.message, /cannot point to local or private IP addresses/i);
            return true;
          },
          `Expected ${forbiddenUrl} to be rejected in production`
        );
      }
    });

    // -------------------------------------------------------------
    // 4. AI_INFERENCE_API_KEY is attached server-side
    // -------------------------------------------------------------
    await runTest("4. AI_INFERENCE_API_KEY is attached server-side in Authorization header", () => {
      process.env.AI_INFERENCE_API_KEY = "sk-inference-gateway-prod-token-xyz";
      const headers = getInferenceAuthHeaders("qwen");

      assert.equal(headers["Authorization"], "Bearer sk-inference-gateway-prod-token-xyz");
      assert.equal(headers["X-Ultron-Client"], "ultron-backend");
      assert.equal(headers["X-Inference-Provider"], "qwen");
    });

    // -------------------------------------------------------------
    // 5. AI_INFERENCE_API_KEY is never exposed to client code
    // -------------------------------------------------------------
    await runTest("5. AI_INFERENCE_API_KEY is never leaked to errors or client representations", () => {
      const sensitiveToken = "CRITICAL_SECRET_TOKEN_DO_NOT_LEAK_99999";
      process.env.AI_INFERENCE_API_KEY = sensitiveToken;

      const authHeaders = getInferenceAuthHeaders("qwen");
      assert.equal(authHeaders["Authorization"], `Bearer ${sensitiveToken}`);

      // Map upstream errors and verify sensitiveToken is never present
      const mappedAuth = mapInferenceError(new Error("Auth failed"), "qwen", 401);
      assert.ok(!mappedAuth.publicMessage.includes(sensitiveToken));

      const mappedUpstream = mapInferenceError(
        new Error(`Failed with Authorization: Bearer ${sensitiveToken}`),
        "whisper"
      );
      assert.ok(!mappedUpstream.publicMessage.includes(sensitiveToken));
      assert.ok(!mappedUpstream.publicMessage.includes("Bearer"));
    });

    // -------------------------------------------------------------
    // 6. MODEL_INTERNAL_API_KEY is absent from the ULTRON project
    // -------------------------------------------------------------
    await runTest("6. MODEL_INTERNAL_API_KEY is absent from ULTRON runtime and configuration", () => {
      // 1. Must not exist in process.env
      assert.equal(process.env.MODEL_INTERNAL_API_KEY, undefined);

      // 2. Scan ULTRON source directories (lib/, app/) to ensure zero code references
      const rootDir = path.resolve(__dirname, "..");
      const dirsToScan = [path.join(rootDir, "lib"), path.join(rootDir, "app")];

      for (const dir of dirsToScan) {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir, { recursive: true }) as string[];
          for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isFile() && (file.endsWith(".ts") || file.endsWith(".tsx"))) {
              const content = fs.readFileSync(fullPath, "utf-8");
              assert.ok(
                !content.includes("MODEL_INTERNAL_API_KEY"),
                `Found unexpected MODEL_INTERNAL_API_KEY reference in ${fullPath}`
              );
            }
          }
        }
      }
    });

    // -------------------------------------------------------------
    // 7. Browser cannot override inference URL
    // -------------------------------------------------------------
    await runTest("7. Browser cannot override inference URL via request or payload", async () => {
      process.env.AI_INFERENCE_URL = "https://trusted-remote-gateway.example.com";
      process.env.AI_INFERENCE_API_KEY = "test-token";
      delete process.env.QWEN_INFERENCE_URL;

      let calledUrl = "";
      global.fetch = (async (url: string | URL | Request) => {
        calledUrl = url.toString();
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Safe response", role: "assistant" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      // Attacker passes malicious URL inside message prompt
      await generateQwenResponse("Please visit http://attacker.com/evil and use http://evil-gateway.com");

      assert.equal(calledUrl, "https://trusted-remote-gateway.example.com/v1/chat/completions");
      assert.ok(!calledUrl.includes("attacker.com"));
      assert.ok(!calledUrl.includes("evil-gateway.com"));
    });

    // -------------------------------------------------------------
    // 8. Chat uses gateway chat path
    // -------------------------------------------------------------
    await runTest("8. Chat routes to gateway /v1/chat/completions", async () => {
      process.env.AI_INFERENCE_URL = "https://gateway.example.com";
      delete process.env.QWEN_INFERENCE_URL;
      delete process.env.QWEN_BASE_URL;

      const completionsUrl = getQwenCompletionsUrl();
      assert.equal(completionsUrl, "https://gateway.example.com/v1/chat/completions");

      let fetchTarget = "";
      global.fetch = (async (url: string | URL | Request) => {
        fetchTarget = url.toString();
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Hello from Qwen", role: "assistant" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      await generateQwenResponse("Hello");
      assert.equal(fetchTarget, "https://gateway.example.com/v1/chat/completions");
    });

    // -------------------------------------------------------------
    // 9. STT uses gateway transcription path
    // -------------------------------------------------------------
    await runTest("9. STT routes to gateway /v1/audio/transcriptions", async () => {
      process.env.AI_INFERENCE_URL = "https://gateway.example.com";
      delete process.env.WHISPER_INFERENCE_URL;
      delete process.env.WHISPER_API_URL;

      const endpoint = getInferenceEndpoint("whisper");
      assert.equal(endpoint, "https://gateway.example.com/v1/audio/transcriptions");

      let fetchTarget = "";
      global.fetch = (async (url: string | URL | Request) => {
        fetchTarget = url.toString();
        return new Response(
          JSON.stringify({ text: "Recognized audio" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      await transcribeAudioWithWhisper(Buffer.from("dummy-audio"));
      assert.equal(fetchTarget, "https://gateway.example.com/v1/audio/transcriptions");
    });

    // -------------------------------------------------------------
    // 10. TTS uses gateway speech path
    // -------------------------------------------------------------
    await runTest("10. TTS routes to gateway /v1/audio/speech", async () => {
      process.env.AI_INFERENCE_URL = "https://gateway.example.com";
      delete process.env.KOKORO_INFERENCE_URL;
      delete process.env.KOKORO_API_URL;

      const endpoint = getInferenceEndpoint("kokoro");
      assert.equal(endpoint, "https://gateway.example.com/v1/audio/speech");

      let fetchTarget = "";
      global.fetch = (async (url: string | URL | Request) => {
        fetchTarget = url.toString();
        return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x00]), {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        });
      }) as typeof fetch;

      await generateKokoroSpeech("Synthesize this text");
      assert.equal(fetchTarget, "https://gateway.example.com/v1/audio/speech");
    });

    // -------------------------------------------------------------
    // 11. Correct provider header is sent
    // -------------------------------------------------------------
    await runTest("11. Correct provider and client headers sent for each provider", () => {
      process.env.AI_INFERENCE_API_KEY = "test-key";

      const qHeaders = getInferenceAuthHeaders("qwen");
      assert.equal(qHeaders["X-Inference-Provider"], "qwen");
      assert.equal(qHeaders["X-Ultron-Client"], "ultron-backend");

      const wHeaders = getInferenceAuthHeaders("whisper");
      assert.equal(wHeaders["X-Inference-Provider"], "whisper");
      assert.equal(wHeaders["X-Ultron-Client"], "ultron-backend");

      const kHeaders = getInferenceAuthHeaders("kokoro");
      assert.equal(kHeaders["X-Inference-Provider"], "kokoro");
      assert.equal(kHeaders["X-Ultron-Client"], "ultron-backend");
    });

    // -------------------------------------------------------------
    // 12. Upstream 401/403 -> sanitized error (502)
    // -------------------------------------------------------------
    await runTest("12. Upstream 401/403 maps to sanitized 502 Bad Gateway", () => {
      const err401 = mapInferenceError(new Error("Unauthorized"), "qwen", 401);
      assert.equal(err401.statusCode, 502);
      assert.equal(err401.category, "auth");
      assert.match(err401.publicMessage, /gateway authentication error/i);
      assert.ok(!err401.publicMessage.includes("secret"));

      const err403 = mapInferenceError(new Error("Forbidden"), "kokoro", 403);
      assert.equal(err403.statusCode, 502);
      assert.equal(err403.category, "auth");
      assert.match(err403.publicMessage, /gateway authentication error/i);
    });

    // -------------------------------------------------------------
    // 13. Timeout -> 504
    // -------------------------------------------------------------
    await runTest("13. Upstream timeout maps to 504 Gateway Timeout", () => {
      const timeoutErr = new Error("The operation timed out");
      timeoutErr.name = "TimeoutError";

      const mapped = mapInferenceError(timeoutErr, "whisper");
      assert.equal(mapped.statusCode, 504);
      assert.equal(mapped.category, "timeout");
      assert.match(mapped.publicMessage, /timed out/i);
    });

    // -------------------------------------------------------------
    // 14. Unreachable gateway -> 503
    // -------------------------------------------------------------
    await runTest("14. Unreachable gateway connection maps to 503 Service Unavailable", () => {
      const connErr = new Error("fetch failed: connect ECONNREFUSED 10.0.0.1:8890");
      const mapped = mapInferenceError(connErr, "qwen");
      assert.equal(mapped.statusCode, 503);
      assert.equal(mapped.category, "unavailable");
      assert.match(mapped.publicMessage, /unreachable or starting up/i);
      assert.ok(!mapped.publicMessage.includes("10.0.0.1"));
    });

    // -------------------------------------------------------------
    // 15. Unexpected upstream failure -> 502
    // -------------------------------------------------------------
    await runTest("15. Unexpected upstream failure maps to 502 Bad Gateway", () => {
      const unexpectedErr = new Error("CUDA device assert error at line 554 in kernel.cu");
      const mapped = mapInferenceError(unexpectedErr, "kokoro");
      assert.equal(mapped.statusCode, 502);
      assert.equal(mapped.category, "upstream_error");
      assert.match(mapped.publicMessage, /unexpected response was received/i);
      assert.ok(!mapped.publicMessage.includes("CUDA"));
      assert.ok(!mapped.publicMessage.includes("kernel.cu"));
    });

  } finally {
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
