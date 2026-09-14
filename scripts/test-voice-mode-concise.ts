import assert from "node:assert/strict";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postTTS } from "../app/api/voice/tts/route";

async function runVoiceModeTests() {
  console.log("==================================================");
  console.log("   ULTRON VOICE MODE CONCISE RESPONSE TEST        ");
  console.log("==================================================\n");

  const query = "Explain how binary search works.";

  // 1. Test normal text chat (voiceMode: false or omitted)
  console.log("[Test 1] Testing normal text chat with detailed query...");
  const textReq = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: query,
    }),
  });

  const textRes = await postChat(textReq);
  assert.equal(textRes.status, 200, "Chat route must return HTTP 200");
  const textData = await textRes.json();
  const textReply = textData.text || textData.reply;
  console.log(`Normal Chat Response Length: ${textReply.length} characters`);
  console.log(`Normal Chat Sample: "${textReply.substring(0, 120)}..."\n`);
  assert.ok(textReply.length > 250, "Normal text chat should allow detailed multi-sentence explanations");

  // 2. Test Voice Mode chat (voiceMode: true)
  console.log("[Test 2] Testing Voice Mode with the same query...");
  const voiceReq = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: query,
      voiceMode: true,
    }),
  });

  const voiceRes = await postChat(voiceReq);
  assert.equal(voiceRes.status, 200, "Chat route must return HTTP 200 for voiceMode");
  const voiceData = await voiceRes.json();
  const voiceReply = voiceData.text || voiceData.reply;
  console.log(`Voice Mode Response Length: ${voiceReply.length} characters`);
  console.log(`Voice Mode Text: "${voiceReply}"\n`);

  // Assertions for Voice Mode
  assert.ok(voiceReply.length <= 500, `Voice reply must be concise (was ${voiceReply.length} chars)`);
  assert.ok(!voiceReply.includes("```"), "Voice reply must not contain code blocks");
  assert.ok(!voiceReply.includes("**"), "Voice reply should not contain markdown bolding");
  assert.ok(!voiceReply.includes("##"), "Voice reply should not contain markdown headers");

  // Count sentences approximately
  const sentenceCount = voiceReply.split(/[.!?]+/).filter(Boolean).length;
  console.log(`Estimated sentence count: ${sentenceCount}`);
  assert.ok(sentenceCount >= 1 && sentenceCount <= 4, "Voice reply should be 1-4 sentences");

  // 3. Test Kokoro TTS synthesis of the voice response
  console.log("[Test 3] Synthesizing Voice Mode reply via /api/voice/tts...");
  const t0 = Date.now();
  const ttsReq = new Request("http://localhost:3000/api/voice/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: voiceReply,
    }),
  });

  const ttsRes = await postTTS(ttsReq);
  const ttsLatency = Date.now() - t0;
  assert.equal(ttsRes.status, 200, "TTS route must return HTTP 200");
  assert.ok(ttsRes.headers.get("Content-Type")?.includes("audio/wav"));

  const arrayBuffer = await ttsRes.arrayBuffer();
  console.log(`TTS synthesis successful:`);
  console.log(`- Latency: ${ttsLatency} ms (comfortably within 20,000 ms timeout)`);
  console.log(`- Audio size: ${arrayBuffer.byteLength} bytes`);
  assert.ok(ttsLatency < 10000, `Synthesis must complete in under 10 seconds (took ${ttsLatency} ms)`);

  console.log("\n==================================================");
  console.log("   ALL VOICE MODE CONCISE TESTS PASSED!           ");
  console.log("==================================================");
}

runVoiceModeTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
