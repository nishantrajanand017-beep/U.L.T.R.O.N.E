import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { POST as postSTT } from "../app/api/voice/stt/route";

console.log("==========================================");
console.log("   ULTRON WHISPER STT INTEGRATION TEST    ");
console.log("==========================================\n");

async function runAllTests() {
  const webmPath = "C:\\Users\\NISHANT\\whisper-test\\speech.webm";
  const wavPath = "C:\\Users\\NISHANT\\kokoro-test\\http_test_speech.wav";

  // Test 1: Valid WebM/Opus Transcription (VoiceMode real format)
  if (fs.existsSync(webmPath)) {
    console.log("1. Testing valid WebM/Opus audio upload...");
    const webmBuffer = fs.readFileSync(webmPath);
    const webmBlob = new Blob([webmBuffer], { type: "audio/webm" });

    const formData = new FormData();
    formData.append("file", webmBlob, "speech.webm");

    const req = new Request("http://localhost:3000/api/voice/stt", {
      method: "POST",
      body: formData,
    });

    const t0 = Date.now();
    const res = await postSTT(req);
    const latency = Date.now() - t0;

    console.log(`- HTTP Status: ${res.status}`);
    assert.equal(res.status, 200, "Must return HTTP 200");

    const data = await res.json();
    console.log(`- Transcribed text: "${data.text}"`);
    console.log(`- Request Latency: ${latency} ms`);
    assert.ok(data.text && data.text.length > 0, "Transcript must not be empty");
    assert.ok(data.text.toLowerCase().includes("ultron"), "Transcript should identify Ultron");
    console.log("[PASS] WebM/Opus Transcription\n");
  } else {
    console.log("[SKIP] speech.webm not found\n");
  }

  // Test 2: Valid WAV Audio
  if (fs.existsSync(wavPath)) {
    console.log("2. Testing valid WAV audio upload...");
    const wavBuffer = fs.readFileSync(wavPath);
    const wavBlob = new Blob([wavBuffer], { type: "audio/wav" });

    const formData = new FormData();
    formData.append("file", wavBlob, "speech.wav");

    const req = new Request("http://localhost:3000/api/voice/stt", {
      method: "POST",
      body: formData,
    });

    const res = await postSTT(req);
    console.log(`- HTTP Status: ${res.status}`);
    assert.equal(res.status, 200, "Must return HTTP 200");

    const data = await res.json();
    console.log(`- Transcribed text: "${data.text}"`);
    assert.ok(data.text && data.text.length > 0, "Transcript must not be empty");
    console.log("[PASS] WAV Transcription\n");
  }

  // Test 3: Empty File (0 Bytes)
  console.log("3. Testing empty audio file (0 bytes)...");
  {
    const emptyBlob = new Blob([], { type: "audio/webm" });
    const formData = new FormData();
    formData.append("file", emptyBlob, "empty.webm");

    const req = new Request("http://localhost:3000/api/voice/stt", {
      method: "POST",
      body: formData,
    });

    const res = await postSTT(req);
    console.log(`- HTTP Status: ${res.status}`);
    assert.equal(res.status, 400, "Empty file must return HTTP 400");
    const data = await res.json();
    console.log(`- Error message: "${data.error}"`);
    console.log("[PASS] Empty Audio Rejection\n");
  }

  // Test 4: Missing File in Form Data
  console.log("4. Testing missing file in form data...");
  {
    const formData = new FormData();
    formData.append("other_field", "some_data");

    const req = new Request("http://localhost:3000/api/voice/stt", {
      method: "POST",
      body: formData,
    });

    const res = await postSTT(req);
    console.log(`- HTTP Status: ${res.status}`);
    assert.equal(res.status, 400, "Missing file must return HTTP 400");
    console.log("[PASS] Missing File Rejection\n");
  }

  // Test 5: Malformed Audio (Random noise bytes)
  console.log("5. Testing malformed audio bytes...");
  {
    const corruptBlob = new Blob([Buffer.from("NOT_A_VALID_AUDIO_CORRUPT_BYTES_XYZ_123")], { type: "audio/webm" });
    const formData = new FormData();
    formData.append("file", corruptBlob, "corrupt.webm");

    const req = new Request("http://localhost:3000/api/voice/stt", {
      method: "POST",
      body: formData,
    });

    const res = await postSTT(req);
    console.log(`- HTTP Status: ${res.status}`);
    assert.ok(res.status >= 400, "Malformed audio must return an error status (>= 400)");
    const data = await res.json();
    console.log(`- Error handled cleanly: "${data.error}"`);
    console.log("[PASS] Malformed Audio Handling\n");
  }

  // Test 6: Upstream Server Unavailable
  console.log("6. Testing upstream Whisper server unavailable...");
  {
    const originalUrl = process.env.WHISPER_API_URL;
    try {
      process.env.WHISPER_API_URL = "http://127.0.0.1:9999/unreachable";
      const validBlob = new Blob([Buffer.from("dummy audio content")], { type: "audio/webm" });
      const formData = new FormData();
      formData.append("file", validBlob, "speech.webm");

      const req = new Request("http://localhost:3000/api/voice/stt", {
        method: "POST",
        body: formData,
      });

      const res = await postSTT(req);
      console.log(`- HTTP Status: ${res.status}`);
      assert.ok(res.status === 502 || res.status === 503 || res.status === 500, "Unreachable server must return 502/503/500");
      const data = await res.json();
      console.log(`- Clean error message: "${data.error}"`);
      console.log("[PASS] Upstream Server Unavailable Handling\n");
    } finally {
      if (originalUrl) {
        process.env.WHISPER_API_URL = originalUrl;
      } else {
        delete process.env.WHISPER_API_URL;
      }
    }
  }

  console.log("==========================================");
  console.log("   ALL WHISPER STT INTEGRATION TESTS: PASS");
  console.log("==========================================");
}

runAllTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
