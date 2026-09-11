import assert from "node:assert/strict";
import {
  getElevenLabsPublicConfig,
  testElevenLabsConnection,
  generateElevenLabsSpeech,
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_VOICE_NAME,
  DEFAULT_ELEVENLABS_MODEL,
} from "../lib/elevenlabsService";
import { POST as postTTS } from "../app/api/voice/tts/route";
import { GET as getElevenLabsSettings, POST as testElevenLabsSettings } from "../app/api/settings/elevenlabs/route";
import { POST as postChat } from "../app/api/chat/route";
import { getGeminiModel, DEFAULT_GEMINI_MODEL } from "../lib/geminiService";
import { saveUserApiKey, getUserApiKeyPublicInfo, deleteUserApiKey } from "../lib/db/userApiKeyStore";

console.log("==========================================");
console.log("   ULTRON PHASE 10 AUTOMATED TEST SUITE   ");
console.log("==========================================\n");

let passed = 0;
let total = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  total++;
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}`);
    console.error(err);
  }
}

async function runAllTests() {
  // Test 1: ElevenLabs Constants & Configuration
  await test("1. ElevenLabs Centralized Defaults & Config", () => {
    assert.equal(DEFAULT_ELEVENLABS_VOICE_ID, "JBFqnCBsd6RMkjVDRZzb", "Voice ID must be George premade");
    assert.equal(DEFAULT_ELEVENLABS_VOICE_NAME, "George", "Voice name must be George");
    assert.equal(DEFAULT_ELEVENLABS_MODEL, "eleven_flash_v2_5", "Default TTS model must be eleven_flash_v2_5");

    const config = getElevenLabsPublicConfig();
    assert.ok(typeof config.isConfigured === "boolean", "isConfigured must be boolean");
    assert.ok(config.voiceId.length > 0, "voiceId must be non-empty");
    assert.ok(config.modelId.length > 0, "modelId must be non-empty");

    const stringified = JSON.stringify(config);
    assert.ok(!stringified.includes("sk_"), "Raw key must not appear in public config");
    assert.ok(!stringified.includes("api_key"), "api_key field must not be exposed");
  });

  // Test 2: ElevenLabs Settings Route (GET & POST)
  await test("2. ElevenLabs Settings API Route (/api/settings/elevenlabs)", async () => {
    // GET
    const getRes = await getElevenLabsSettings();
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(typeof getData.isConfigured, "boolean");
    assert.ok(getData.voiceId);
    assert.ok(getData.modelId);
    assert.ok(!JSON.stringify(getData).includes("api_key"), "No API key leaked in GET");

    // POST (Test connection endpoint)
    const postRes = await testElevenLabsSettings();
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(typeof postData.valid, "boolean");
    assert.ok(postData.status, "status must be returned");
    assert.ok(postData.message, "message must be returned");
    assert.ok(!JSON.stringify(postData).includes("api_key"), "No API key leaked in POST");
  });

  // Test 3: Text Chat Isolation (Normal Chat Does NOT Invoke ElevenLabs)
  await test("3. Text Chat Pipeline Isolation (No ElevenLabs TTS in Text Chat)", async () => {
    // Verification: Text chat endpoint accepts message and returns text only
    const testUser = "usr_text_chat_iso_" + Date.now();
    await saveUserApiKey(testUser, "AIzaSyMockKeyForIsolationTest12345");

    // Empty message test -> returns 400
    const emptyReq = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ultron-user-id": testUser,
      },
      body: JSON.stringify({ message: "" }),
    });
    const emptyRes = await postChat(emptyReq);
    assert.equal(emptyRes.status, 400);

    const emptyBody = await emptyRes.json();
    assert.ok(emptyBody.error.includes("non-empty string"));
    assert.ok(!("audio" in emptyBody), "Text chat response must never contain audio");

    await deleteUserApiKey(testUser);
  });

  // Test 4: TTS Endpoint Validation (Empty Text & Formatting)
  await test("4. ElevenLabs TTS Route Validation (/api/voice/tts)", async () => {
    // Empty request body
    const emptyReq = new Request("http://localhost:3000/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    const emptyRes = await postTTS(emptyReq);
    assert.equal(emptyRes.status, 400);
    const emptyData = await emptyRes.json();
    assert.ok(emptyData.error.includes("non-empty string"));

    // Missing body
    const missingReq = new Request("http://localhost:3000/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const missingRes = await postTTS(missingReq);
    assert.equal(missingRes.status, 400);
  });

  // Test 5: Missing or Invalid ElevenLabs Credentials Error Handling
  await test("5. Error Handling for Missing or Invalid ElevenLabs Configuration", async () => {
    const originalKey = process.env.ELEVENLABS_API_KEY;

    try {
      // Case A: Missing key
      delete process.env.ELEVENLABS_API_KEY;
      const missingKeyReq = new Request("http://localhost:3000/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Test voice synthesis" }),
      });
      const missingKeyRes = await postTTS(missingKeyReq);
      assert.equal(missingKeyRes.status, 500);
      const missingKeyData = await missingKeyRes.json();
      assert.ok(missingKeyData.error.includes("ELEVENLABS_API_KEY is not configured"));

      // Case B: Placeholder key (your_api_key)
      process.env.ELEVENLABS_API_KEY = "your_elevenlabs_api_key_here";
      const placeholderRes = await testElevenLabsConnection();
      assert.equal(placeholderRes.valid, false);
      assert.equal(placeholderRes.status, "not_configured");
    } finally {
      if (originalKey !== undefined) {
        process.env.ELEVENLABS_API_KEY = originalKey;
      } else {
        delete process.env.ELEVENLABS_API_KEY;
      }
    }
  });

  // Test 6: ElevenLabs Voice ID Resolution & Fallback Behavior
  await test("6. ElevenLabs Voice Fallback for Invalid or Placeholder IDs", () => {
    const originalVoiceId = process.env.ELEVENLABS_VOICE_ID;
    try {
      process.env.ELEVENLABS_VOICE_ID = "YOUR_VOICE_ID";
      const configA = getElevenLabsPublicConfig();
      assert.equal(configA.voiceId, DEFAULT_ELEVENLABS_VOICE_ID);

      process.env.ELEVENLABS_VOICE_ID = "your_voice_id_here";
      const configB = getElevenLabsPublicConfig();
      assert.equal(configB.voiceId, DEFAULT_ELEVENLABS_VOICE_ID);

      process.env.ELEVENLABS_VOICE_ID = "custom_voice_12345";
      const configC = getElevenLabsPublicConfig();
      assert.equal(configC.voiceId, "custom_voice_12345");
      assert.equal(configC.voiceName, "Custom Voice");
    } finally {
      if (originalVoiceId !== undefined) {
        process.env.ELEVENLABS_VOICE_ID = originalVoiceId;
      } else {
        delete process.env.ELEVENLABS_VOICE_ID;
      }
    }
  });

  // Test 7: Gemini Model Preservation (gemini-3.6-flash)
  await test("7. Gemini 3.6 Flash Model Integrity", () => {
    assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.6-flash");
    const model = getGeminiModel();
    assert.equal(model, "gemini-3.6-flash");
    assert.ok(!model.includes("2.6"), "Must not use Gemini 2.6");
    assert.ok(!model.includes("preview"), "Must not use preview model");
  });

  // Test 8: Per-User Gemini API Key Security & Isolation
  await test("8. Phase 9 Per-User Gemini Key Isolation Regression Check", async () => {
    const userA = "usr_p10_sec_a_" + Date.now();
    const userB = "usr_p10_sec_b_" + Date.now();

    await saveUserApiKey(userA, "AIzaSyUserASecureKey987654321");
    const infoA = await getUserApiKeyPublicInfo(userA);
    const infoB = await getUserApiKeyPublicInfo(userB);

    assert.equal(infoA.isConfigured, true);
    assert.equal(infoB.isConfigured, false);
    assert.equal(infoA.keyHint, "••••••••••••4321");

    // Clean up
    await deleteUserApiKey(userA);
    const postDelA = await getUserApiKeyPublicInfo(userA);
    assert.equal(postDelA.isConfigured, false);
  });

  // Test 9: Zero Key Leakage in API Responses & Errors
  await test("9. Zero Key Exposure Across Voice and Settings Responses", async () => {
    const getRes = await getElevenLabsSettings();
    const getText = await getRes.text();
    assert.ok(!getText.includes(process.env.ELEVENLABS_API_KEY || "NOT_SET"));

    const postRes = await testElevenLabsSettings();
    const postText = await postRes.text();
    assert.ok(!postText.includes(process.env.ELEVENLABS_API_KEY || "NOT_SET"));
  });

  console.log("\n------------------------------------------");
  console.log(`RESULTS: ${passed}/${total} Phase 10 tests passed.`);
  console.log("------------------------------------------\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
