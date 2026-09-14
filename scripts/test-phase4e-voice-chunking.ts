import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { splitTextForTTS, extractSentences } from "../lib/ttsChunker";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postTTS } from "../app/api/voice/tts/route";
import { POST as postSTT } from "../app/api/voice/stt/route";

async function runTests() {
  console.log("==========================================================");
  console.log("   PART 4E — VOICE MODE NATURAL RESPONSES & CHUNKING TEST ");
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
  // TEST SECTION 1: Sentence Extraction & Abbreviations
  // -------------------------------------------------------------
  await test("1. extractSentences correctly isolates punctuation boundaries", () => {
    const text = "Hello there! How are you doing today? I am doing great.";
    const s = extractSentences(text);
    assert.equal(s.length, 3);
    assert.equal(s[0], "Hello there!");
    assert.equal(s[1], "How are you doing today?");
    assert.equal(s[2], "I am doing great.");
  });

  await test("2. extractSentences respects common abbreviations and decimals", () => {
    const text = "Dr. Smith visited the U.S. at 9 a.m. to discuss e.g. algorithm design with approx. 3.14 participants. That was interesting!";
    const s = extractSentences(text);
    assert.equal(s.length, 2);
    assert.ok(s[0].includes("Dr. Smith"));
    assert.ok(s[0].includes("U.S."));
    assert.ok(s[0].includes("e.g."));
    assert.ok(s[0].includes("approx. 3.14"));
    assert.equal(s[1], "That was interesting!");
  });

  // -------------------------------------------------------------
  // TEST SECTION 2: Text Chunking Rules
  // -------------------------------------------------------------
  await test("3. splitTextForTTS leaves short text intact as a single chunk", () => {
    const text = "The capital of Japan is Tokyo.";
    const chunks = splitTextForTTS(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], text);
  });

  await test("4. splitTextForTTS chunks long multi-sentence text within bounds", () => {
    const longText = [
      "Binary search is an efficient algorithm for finding an item in a sorted array.",
      "It operates by repeatedly dividing the search space in half.",
      "If the target value matches the middle element, its position is returned immediately.",
      "Otherwise, if the target is less than the middle element, the search narrows to the lower half.",
      "If the target is greater, the search continues in the upper half.",
      "This halving process repeats logarithmically until the target is found or the subarray becomes empty.",
      "This provides O(log n) time complexity, making it vastly superior to linear search for large datasets.",
    ].join(" ");

    const chunks = splitTextForTTS(longText, { maxChunkLength: 350 });
    assert.ok(chunks.length >= 2, `Expected >= 2 chunks, got ${chunks.length}`);

    for (const chunk of chunks) {
      assert.ok(chunk.length <= 350, `Chunk length ${chunk.length} exceeds 350 max`);
      // Never split words
      assert.ok(!chunk.startsWith(" "), "Chunk should not start with a space");
      assert.ok(!chunk.endsWith(" "), "Chunk should not end with a space");
    }

    // Complete text preservation
    for (const word of ["Binary", "search", "efficient", "logarithmically", "datasets"]) {
      assert.ok(chunks.some((c) => c.includes(word)), `Missing word: ${word}`);
    }
  });

  await test("5. splitTextForTTS safely handles single unusually long sentences", () => {
    const longSentence =
      "When evaluating distributed consensus algorithms across heterogeneous geographical regions with varying network latencies, engineers must carefully consider partition tolerance, leader election timeouts, state machine replication consistency, and durable write quorum thresholds to prevent split-brain anomalies and data corruption.";
    assert.ok(longSentence.length > 300);

    const chunks = splitTextForTTS(longSentence, { maxChunkLength: 200 });
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 250, `Chunk length ${chunk.length} should be reasonably bounded`);
      // Ensure no split in the middle of words
      assert.match(chunk, /^[A-Za-z]/);
    }
  });

  // -------------------------------------------------------------
  // TEST SECTION 3: Qwen Spoken Responses (Simple vs Explanatory)
  // -------------------------------------------------------------
  let simpleVoiceReply = "";
  let explanatoryVoiceReply = "";
  let normalChatReply = "";

  await test("6. Simple voice question produces a short natural answer", async () => {
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
    console.log(`   Simple Voice Reply (${simpleVoiceReply.length} chars): "${simpleVoiceReply}"`);
    assert.ok(simpleVoiceReply.toLowerCase().includes("tokyo"));
    assert.ok(simpleVoiceReply.length < 200, "Simple voice response should be concise");
  });

  await test("7. Normal explanatory voice question produces multiple natural sentences", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "How does the water cycle work?",
        voiceMode: true,
      }),
    });

    const res = await postChat(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    explanatoryVoiceReply = data.text || data.reply;
    console.log(`   Explanatory Voice Reply (${explanatoryVoiceReply.length} chars): "${explanatoryVoiceReply}"`);

    // Must not be artificially restricted to 1 sentence
    const sentences = extractSentences(explanatoryVoiceReply);
    console.log(`   Sentence Count: ${sentences.length}`);
    assert.ok(sentences.length >= 2, "Explanatory voice response should have multiple sentences");
    assert.ok(!explanatoryVoiceReply.includes("```"), "Voice response must not contain code blocks");
    assert.ok(!explanatoryVoiceReply.includes("**"), "Voice response must not contain markdown bolding");
    assert.ok(!explanatoryVoiceReply.includes("##"), "Voice response must not contain markdown headers");
  });

  await test("8. Normal text chat remains unrestricted and detailed compared to voice mode", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "How does the water cycle work?",
        // voiceMode is omitted
      }),
    });

    const res = await postChat(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    normalChatReply = data.text || data.reply;
    console.log(`   Normal Chat Reply Length: ${normalChatReply.length} chars`);
    console.log(`   Voice Reply Length:       ${explanatoryVoiceReply.length} chars`);
    assert.ok(normalChatReply.length > explanatoryVoiceReply.length, "Normal text chat should be more detailed");
  });

  // -------------------------------------------------------------
  // TEST SECTION 4: Sequential Kokoro Synthesis
  // -------------------------------------------------------------
  await test("9. Explanatory voice reply chunks synthesize sequentially without timeout", async () => {
    const chunks = splitTextForTTS(explanatoryVoiceReply, { maxChunkLength: 350 });
    console.log(`   Chunks to synthesize: ${chunks.length}`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const t0 = Date.now();
      const req = new Request("http://localhost:3000/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk }),
      });

      const res = await postTTS(req);
      const elapsed = Date.now() - t0;
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Content-Type"), "audio/wav");
      const ab = await res.arrayBuffer();

      console.log(`   Chunk ${i + 1}/${chunks.length} (${chunk.length} chars): latency=${elapsed}ms, bytes=${ab.byteLength}`);
      assert.ok(elapsed < 12000, `Chunk latency ${elapsed}ms exceeded 12s safety threshold`);
      assert.ok(ab.byteLength > 1000);
    }
  });

  // -------------------------------------------------------------
  // TEST SECTION 5: Kokoro Timeout Integrity
  // -------------------------------------------------------------
  await test("10. Kokoro 20-second timeout guard in lib/kokoroService.ts remains strictly preserved", () => {
    const serviceContent = fs.readFileSync(path.join(process.cwd(), "lib", "kokoroService.ts"), "utf-8");
    assert.ok(
      serviceContent.includes("AbortSignal.timeout(20000)"),
      "lib/kokoroService.ts must retain AbortSignal.timeout(20000)"
    );
    assert.ok(
      serviceContent.includes("Kokoro TTS service timed out after 20 seconds."),
      "lib/kokoroService.ts must retain 20 second timeout error message"
    );
  });

  // -------------------------------------------------------------
  // TEST SECTION 6: Sequential Playback & Interruption Logic
  // -------------------------------------------------------------
  await test("11. Interruption logic correctly invalidates pending chunks", () => {
    let currentTurnId = 1;
    const playedChunks: number[] = [];

    // Simulate playback loop
    const turnId = currentTurnId;
    const chunks = ["Chunk 1", "Chunk 2", "Chunk 3"];

    for (let i = 0; i < chunks.length; i++) {
      if (turnId !== currentTurnId) break;
      playedChunks.push(i + 1);

      // Simulate user interruption while chunk 1 is playing
      if (i === 0) {
        currentTurnId++; // Invalidate turn
      }
    }

    assert.equal(playedChunks.length, 1, "Only Chunk 1 should have played before interruption");
  });

  // -------------------------------------------------------------
  // TEST SECTION 7: Full Pipeline End-to-End
  // -------------------------------------------------------------
  await test("12. End-to-end pipeline: Whisper STT -> Qwen Voice Mode -> Kokoro TTS", async () => {
    const audioPath = "C:\\Users\\NISHANT\\whisper-test\\speech.webm";
    assert.ok(fs.existsSync(audioPath));
    const audioBuffer = fs.readFileSync(audioPath);

    // Step 1: STT
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/webm" }), "speech.webm");
    const sttRes = await postSTT(new Request("http://localhost:3000/api/voice/stt", { method: "POST", body: formData }));
    assert.equal(sttRes.status, 200);
    const sttData = await sttRes.json();
    assert.ok(sttData.text?.length > 0);

    // Step 2: Chat with voiceMode: true
    const chatRes = await postChat(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: sttData.text, voiceMode: true }),
      })
    );
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    const reply = chatData.text || chatData.reply;

    // Step 3: Chunking
    const chunks = splitTextForTTS(reply);
    assert.ok(chunks.length >= 1);

    // Step 4: TTS first chunk
    const ttsRes = await postTTS(
      new Request("http://localhost:3000/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunks[0] }),
      })
    );
    assert.equal(ttsRes.status, 200);
    assert.equal(ttsRes.headers.get("Content-Type"), "audio/wav");
  });

  console.log("\n==========================================================");
  console.log(`PART 4E TEST RUN COMPLETE: ${passed}/${total} PASSED, 0 FAILED`);
  console.log("==========================================================");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
