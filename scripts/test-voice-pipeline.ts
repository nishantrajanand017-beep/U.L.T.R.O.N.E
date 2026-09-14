import assert from "node:assert/strict";
import fs from "node:fs";
import { POST as postSTT } from "../app/api/voice/stt/route";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postTTS } from "../app/api/voice/tts/route";

console.log("==================================================");
console.log("   ULTRON FULL LOCAL PIPELINE INTEGRATION TEST   ");
console.log("      Whisper (STT) -> Qwen (LLM) -> Kokoro (TTS) ");
console.log("==================================================\n");

async function runEndToEndPipeline() {
  const audioFilePath = "C:\\Users\\NISHANT\\whisper-test\\speech.webm";
  assert.ok(fs.existsSync(audioFilePath), `Audio file not found: ${audioFilePath}`);
  const audioBuffer = fs.readFileSync(audioFilePath);

  // STEP 1: Whisper STT (/api/voice/stt)
  console.log("[Step 1] Sending user audio to /api/voice/stt (Whisper large-v3-turbo)...");
  const formData = new FormData();
  const audioBlob = new Blob([audioBuffer], { type: "audio/webm" });
  formData.append("file", audioBlob, "speech.webm");

  const t0_stt = performance.now();
  const sttReq = new Request("http://localhost:3000/api/voice/stt", {
    method: "POST",
    body: formData,
  });
  const sttRes = await postSTT(sttReq);
  const t1_stt = performance.now();

  assert.equal(sttRes.status, 200, "STT route must return HTTP 200");
  const sttData = await sttRes.json();
  const userTranscript = sttData.text?.trim() || "";
  console.log(`[STT Success] Latency: ${(t1_stt - t0_stt).toFixed(0)}ms | Provider: ${sttData.provider}`);
  console.log(`User Transcript: "${userTranscript}"\n`);
  assert.ok(userTranscript.length > 0, "Transcript must not be empty");

  // STEP 2: Qwen LLM (/api/chat)
  console.log("[Step 2] Sending transcript to /api/chat (Qwen3-8B via Ollama)...");
  const t0_chat = performance.now();
  const chatReq = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: userTranscript,
      voiceMode: true,
    }),
  });
  const chatRes = await postChat(chatReq);
  const t1_chat = performance.now();

  assert.equal(chatRes.status, 200, "Chat route must return HTTP 200");
  const chatData = await chatRes.json();
  const ultronReply = chatData.text || chatData.reply || "";
  console.log(`[Chat Success] Latency: ${(t1_chat - t0_chat).toFixed(0)}ms | Source: ${chatData.source}`);
  console.log(`ULTRON Reply: "${ultronReply}"\n`);
  assert.equal(chatData.source, "qwen", "Chat response source must be 'qwen'");
  assert.ok(ultronReply.length > 0, "ULTRON reply must not be empty");

  // STEP 3: Kokoro TTS (/api/voice/tts)
  console.log("[Step 3] Sending ULTRON reply to /api/voice/tts (Kokoro-82M)...");
  const t0_tts = performance.now();
  const ttsReq = new Request("http://localhost:3000/api/voice/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: ultronReply,
      voice: "am_adam",
    }),
  });
  const ttsRes = await postTTS(ttsReq);
  const t1_tts = performance.now();

  assert.equal(ttsRes.status, 200, "TTS route must return HTTP 200");
  assert.equal(ttsRes.headers.get("Content-Type"), "audio/wav", "TTS content type must be audio/wav");
  const wavArrayBuffer = await ttsRes.arrayBuffer();
  const wavBuffer = Buffer.from(wavArrayBuffer);
  console.log(`[TTS Success] Latency: ${(t1_tts - t0_tts).toFixed(0)}ms | Audio Bytes: ${wavBuffer.length}`);

  // Validate WAV header
  assert.ok(wavBuffer.length >= 44, "WAV buffer must contain header");
  assert.equal(wavBuffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(wavBuffer.toString("ascii", 8, 12), "WAVE");
  const sampleRate = wavBuffer.readUInt32LE(24);
  const channels = wavBuffer.readUInt16LE(22);
  const bitsPerSample = wavBuffer.readUInt16LE(34);
  assert.equal(sampleRate, 24000, "Sample rate must be 24000 Hz");
  assert.equal(channels, 1, "Channel count must be 1 (mono)");
  assert.equal(bitsPerSample, 16, "Bit depth must be 16-bit");

  const totalPipelineTime = (t1_tts - t0_stt) / 1000;
  console.log(`\n==================================================`);
  console.log(`FULL PIPELINE VERIFIED SUCCESSFULLY in ${totalPipelineTime.toFixed(2)}s:`);
  console.log(`  1. STT:    Whisper large-v3-turbo -> ${(t1_stt - t0_stt).toFixed(0)}ms`);
  console.log(`  2. LLM:    Qwen3-8B (Ollama)      -> ${(t1_chat - t0_chat).toFixed(0)}ms`);
  console.log(`  3. TTS:    Kokoro-82M (am_adam)   -> ${(t1_tts - t0_tts).toFixed(0)}ms`);
  console.log(`  4. Audio:  ${wavBuffer.length} bytes, 24kHz 16-bit mono PCM`);
  console.log(`==================================================`);
}

runEndToEndPipeline().catch((err) => {
  console.error("End-to-end pipeline test failed:", err);
  process.exit(1);
});
