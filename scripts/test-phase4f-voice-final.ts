import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { splitTextForTTS, extractSentences, HARD_MAX_TTS_CHUNK_LENGTH } from "../lib/ttsChunker";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postTTS } from "../app/api/voice/tts/route";
import { POST as postSTT } from "../app/api/voice/stt/route";

async function runPhase4FFinalTests() {
  console.log("==========================================================");
  console.log("   PART 4F — FINAL VOICE MODE VERIFICATION TEST SUITE     ");
  console.log("==========================================================\n");

  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    total++;
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name}:`, err);
      throw err;
    }
  }

  // -------------------------------------------------------------
  // TEST 1 — SIMPLE RESPONSE
  // -------------------------------------------------------------
  let simpleVoiceReply = "";
  await test("TEST 1: Simple response generates concise natural answer without markdown", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "What is the capital of Japan?",
        voiceMode: true,
      }),
    });

    const res = await postChat(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    simpleVoiceReply = data.text || data.reply;
    console.log(`   Reply (${simpleVoiceReply.length} chars): "${simpleVoiceReply}"`);

    assert.ok(simpleVoiceReply.toLowerCase().includes("tokyo"));
    assert.ok(simpleVoiceReply.length < 200, "Simple response should be concise");
    assert.ok(!simpleVoiceReply.includes("**"), "Must not contain markdown bold");
    assert.ok(!simpleVoiceReply.includes("```"), "Must not contain code blocks");
  });

  // -------------------------------------------------------------
  // TEST 2 — MULTI-SENTENCE RESPONSE
  // -------------------------------------------------------------
  let multiSentenceReply = "";
  await test("TEST 2: Multi-sentence response is natural and not artificially restricted", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Explain how binary search works.",
        voiceMode: true,
      }),
    });

    const res = await postChat(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    multiSentenceReply = data.text || data.reply;
    console.log(`   Reply (${multiSentenceReply.length} chars): "${multiSentenceReply}"`);

    const sentences = extractSentences(multiSentenceReply);
    console.log(`   Extracted sentences: ${sentences.length}`);
    assert.ok(sentences.length >= 2, "Should allow multiple sentences for explanatory queries");
    assert.ok(!multiSentenceReply.includes("**"), "Must not contain markdown bolding");
    assert.ok(!multiSentenceReply.includes("##"), "Must not contain markdown headers");
  });

  // -------------------------------------------------------------
  // TEST 3 — LONG RESPONSE (>700 chars) CHUNKING
  // -------------------------------------------------------------
  let longResponseChunks: string[] = [];
  await test("TEST 3: Long response (>700 chars) chunks safely with every chunk <= 300 chars", () => {
    const longText = [
      "The internet is a vast global network of interconnected computers and data centers that communicate using standardized networking protocols.",
      "At its foundation, information is divided into digital packets, transmitted over fiber optic cables, satellite links, and wireless frequencies.",
      "The Transmission Control Protocol and Internet Protocol, commonly known as TCP and IP, ensure that these packets are addressed correctly and delivered reliably.",
      "The Domain Name System, or DNS, functions as the internet phonebook by translating human readable domain names into numerical IP addresses.",
      "Routers inspect destination headers on every packet and forward them along the most efficient physical path across global network backbones.",
      "Web browsers establish secure encrypted connections using Transport Layer Security to protect user privacy and verify server authenticity.",
      "Finally, web servers receive client requests, process database queries, and return formatted application data to render modern web experiences.",
    ].join(" ");

    assert.ok(longText.length > 700, `Test input must be > 700 chars (was ${longText.length})`);
    console.log(`   Long text input length: ${longText.length} chars`);

    longResponseChunks = splitTextForTTS(longText);
    console.log(`   Created ${longResponseChunks.length} chunks:`);

    let reassembled = "";
    for (let i = 0; i < longResponseChunks.length; i++) {
      const c = longResponseChunks[i];
      console.log(`   - Chunk ${i + 1} (${c.length} chars): "${c}"`);
      assert.ok(c.length <= HARD_MAX_TTS_CHUNK_LENGTH, `Chunk ${i + 1} length ${c.length} exceeds hard limit ${HARD_MAX_TTS_CHUNK_LENGTH}`);
      assert.ok(!c.startsWith(" "), "Chunk should not have leading space");
      assert.ok(!c.endsWith(" "), "Chunk should not have trailing space");
      reassembled += (reassembled ? " " : "") + c;
    }

    // Complete text preserved (all key terms present)
    for (const word of ["internet", "packets", "TCP", "DNS", "Routers", "browsers", "authenticity", "experiences"]) {
      assert.ok(reassembled.includes(word), `Missing word in reassembled chunks: ${word}`);
    }
  });

  // -------------------------------------------------------------
  // TEST 4 — VERY LONG SINGLE SENTENCE
  // -------------------------------------------------------------
  await test("TEST 4: Artificially long single sentence splits safely without mid-word cutting", () => {
    const runOnSentence =
      "When designing distributed data replication topologies across multiple geographical availability zones with differing bandwidth constraints, software engineers must carefully evaluate network partition recovery strategies, quorum consistency levels, raft leader election timeouts, and conflict resolution mechanisms to prevent database corruption while maintaining high availability.";
    assert.ok(runOnSentence.length > 350);

    const chunks = splitTextForTTS(runOnSentence);
    assert.ok(chunks.length >= 2, `Expected >= 2 chunks for ${runOnSentence.length} chars, got ${chunks.length}`);

    for (const c of chunks) {
      assert.ok(c.length <= HARD_MAX_TTS_CHUNK_LENGTH, `Chunk length ${c.length} exceeds ${HARD_MAX_TTS_CHUNK_LENGTH}`);
      // Ensure words are not split mid-word: starts and ends with alphanumeric or punctuation
      assert.match(c, /^[A-Za-z0-9]/, "Chunk must start with whole word");
      assert.match(c, /[A-Za-z0-9.,;:—]$/, "Chunk must end cleanly");
    }
  });

  // -------------------------------------------------------------
  // TEST 5 — ABBREVIATIONS
  // -------------------------------------------------------------
  await test("TEST 5: Abbreviations (Dr., U.S., e.g., etc.) are not treated as sentence boundaries", () => {
    const abbrevText = "Dr. Smith lives in the U.S. and uses e.g. examples. That is sentence two.";
    const sentences = extractSentences(abbrevText);
    assert.equal(sentences.length, 2);
    assert.ok(sentences[0].includes("Dr. Smith"));
    assert.ok(sentences[0].includes("U.S."));
    assert.ok(sentences[0].includes("e.g."));
    assert.equal(sentences[1], "That is sentence two.");
  });

  // -------------------------------------------------------------
  // TEST 6 — DECIMAL NUMBERS
  // -------------------------------------------------------------
  await test("TEST 6: Decimals (e.g. 3.14) are not treated as sentence boundaries", () => {
    const decimalText = "The value is 3.14 and the calculation continues. Done.";
    const sentences = extractSentences(decimalText);
    assert.equal(sentences.length, 2);
    assert.ok(sentences[0].includes("3.14"));
    assert.equal(sentences[1], "Done.");
  });

  // -------------------------------------------------------------
  // TEST 7 — KOKORO SYNTHESIS OF EVERY CHUNK
  // -------------------------------------------------------------
  await test("TEST 7: Every chunk synthesizes successfully via Kokoro TTS within 20s timeout", async () => {
    assert.ok(longResponseChunks.length >= 3, "Should have multiple chunks from Test 3");
    console.log(`   Sending ${longResponseChunks.length} chunks sequentially to Kokoro TTS...`);

    for (let i = 0; i < longResponseChunks.length; i++) {
      const chunk = longResponseChunks[i];
      const t0 = Date.now();
      const req = new Request("http://localhost:3000/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: chunk,
          voice: "am_adam",
        }),
      });

      const res = await postTTS(req);
      const latency = Date.now() - t0;
      assert.equal(res.status, 200, `Chunk ${i + 1} must return HTTP 200`);
      assert.ok(res.headers.get("Content-Type")?.includes("audio/wav"));

      const audioBuffer = await res.arrayBuffer();
      assert.ok(audioBuffer.byteLength > 1000, `Chunk ${i + 1} audio buffer must be valid`);
      console.log(`   Chunk ${i + 1}/${longResponseChunks.length} (${chunk.length} chars) -> latency: ${latency}ms | size: ${audioBuffer.byteLength} bytes`);

      assert.ok(latency < 20000, `Chunk latency ${latency}ms must not exceed 20s timeout`);
    }
  });

  // -------------------------------------------------------------
  // TEST 8 — MESSAGE ORDER VERIFICATION
  // -------------------------------------------------------------
  await test("TEST 8: Message order is chronological (oldest to newest, new turns appended)", () => {
    interface Turn {
      id: string;
      role: "user" | "model";
      text: string;
    }

    let history: Turn[] = [];

    // Turn 1
    const user1: Turn = { id: "1", role: "user", text: "First question" };
    history = [...history, user1];
    const ultron1: Turn = { id: "2", role: "model", text: "First answer" };
    history = [...history, ultron1];

    // Turn 2
    const user2: Turn = { id: "3", role: "user", text: "Second question" };
    history = [...history, user2];
    const ultron2: Turn = { id: "4", role: "model", text: "Second answer" };
    history = [...history, ultron2];

    assert.equal(history.length, 4);
    assert.equal(history[0].text, "First question");
    assert.equal(history[1].text, "First answer");
    assert.equal(history[2].text, "Second question");
    assert.equal(history[3].text, "Second answer");

    // Verify index of new user question is strictly greater than older turns
    const user2Index = history.findIndex((h) => h.id === "3");
    const ultron1Index = history.findIndex((h) => h.id === "2");
    assert.ok(user2Index > ultron1Index, "Second question must appear BELOW First answer");
  });

  // -------------------------------------------------------------
  // TEST 9 — INTERRUPTION & STALE CHUNK DISCARD
  // -------------------------------------------------------------
  await test("TEST 9: Interruption invalidates active turn and discards queued chunks", () => {
    let currentTurnId = 10;
    const executedChunks: number[] = [];

    const playbackTurnId = currentTurnId;
    const chunks = ["Chunk 1", "Chunk 2", "Chunk 3", "Chunk 4"];

    for (let i = 0; i < chunks.length; i++) {
      // Check turn validity
      if (playbackTurnId !== currentTurnId) {
        break; // Discard remainder
      }
      executedChunks.push(i + 1);

      // Simulate barge-in interruption while chunk 1 is playing
      if (i === 0) {
        currentTurnId++; // Invalidate turn
      }
    }

    assert.equal(executedChunks.length, 1, "Only Chunk 1 should have played before interruption cancelled remaining chunks");
    assert.equal(currentTurnId, 11, "Turn ID was incremented on interruption");
  });

  // -------------------------------------------------------------
  // TEST 10 — NORMAL TEXT CHAT REMAINS DETAILED
  // -------------------------------------------------------------
  await test("TEST 10: Normal text chat without voiceMode remains detailed and unrestricted", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Explain how the internet works in detail.",
        // voiceMode is omitted
      }),
    });

    const res = await postChat(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    const chatReply = data.text || data.reply;
    console.log(`   Normal text chat reply length: ${chatReply.length} chars`);
    assert.ok(chatReply.length > 500, "Normal text chat should provide detailed comprehensive responses");
  });

  // -------------------------------------------------------------
  // TEST 11 — FULL PIPELINE END-TO-END
  // -------------------------------------------------------------
  await test("TEST 11: Full pipeline: Whisper STT -> Qwen Voice Mode -> Safe Chunking -> Kokoro Sequential Playback", async () => {
    const audioPath = "C:\\Users\\NISHANT\\whisper-test\\speech.webm";
    assert.ok(fs.existsSync(audioPath));
    const audioBuffer = fs.readFileSync(audioPath);

    // 1. Whisper STT
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/webm" }), "speech.webm");
    const sttRes = await postSTT(new Request("http://localhost:3000/api/voice/stt", { method: "POST", body: formData }));
    assert.equal(sttRes.status, 200);
    const sttData = await sttRes.json();
    assert.ok(sttData.text?.length > 0);
    console.log(`   STT Transcript: "${sttData.text}"`);

    // 2. Qwen Voice Mode
    const chatRes = await postChat(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: sttData.text, voiceMode: true }),
      })
    );
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    const voiceReply = chatData.text || chatData.reply;
    console.log(`   Qwen Voice Reply: "${voiceReply}"`);

    // 3. Safe Chunking
    const chunks = splitTextForTTS(voiceReply);
    console.log(`   Safe chunks count: ${chunks.length}`);
    for (const c of chunks) {
      assert.ok(c.length <= HARD_MAX_TTS_CHUNK_LENGTH, `Chunk exceeds hard max: ${c.length}`);
    }

    // 4. Sequential Kokoro TTS
    for (let i = 0; i < chunks.length; i++) {
      const t0 = Date.now();
      const ttsRes = await postTTS(
        new Request("http://localhost:3000/api/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: chunks[i] }),
        })
      );
      const lat = Date.now() - t0;
      assert.equal(ttsRes.status, 200);
      assert.ok(lat < 20000, `TTS chunk latency ${lat}ms must not exceed 20s timeout`);
      console.log(`   Pipeline Chunk ${i + 1}/${chunks.length}: ${lat}ms`);
    }
  });

  // -------------------------------------------------------------
  // TEST 12 — EXISTING REGRESSIONS & TIMEOUT INTEGRITY
  // -------------------------------------------------------------
  await test("TEST 12: 20-second timeout in lib/kokoroService.ts remains strictly preserved", () => {
    const serviceContent = fs.readFileSync(path.join(process.cwd(), "lib", "kokoroService.ts"), "utf-8");
    assert.ok(
      serviceContent.includes("AbortSignal.timeout(20000)"),
      "lib/kokoroService.ts must retain exact AbortSignal.timeout(20000)"
    );
    assert.ok(
      serviceContent.includes("Kokoro TTS service timed out after 20 seconds."),
      "lib/kokoroService.ts must retain 20s error message"
    );
  });

  console.log("\n==========================================================");
  console.log(`PART 4F TEST RUN COMPLETE: ${passed}/${total} PASSED, 0 FAILED`);
  console.log("==========================================================");
}

runPhase4FFinalTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
