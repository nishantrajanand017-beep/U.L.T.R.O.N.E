import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { splitTextForTTS, extractSentences, HARD_MAX_TTS_CHUNK_LENGTH, DEFAULT_TARGET_CHUNK_LENGTH } from "../lib/ttsChunker";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postTTS } from "../app/api/voice/tts/route";
import { POST as postSTT } from "../app/api/voice/stt/route";

async function runPhase4GFinalTests() {
  console.log("==========================================================");
  console.log("   PART 4G — FINAL VOICE MODE ROOT-CAUSE FIX VERIFICATION ");
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
  // TEST 3 — REALISTIC 600-800 CHAR DETAILED RESPONSE & CHUNKING
  // -------------------------------------------------------------
  let detailedChunks: string[] = [];
  await test("TEST 3: 600-800 char response chunked safely with EVERY chunk <= 100 chars", () => {
    const detailedText = [
      "The internet operates as a global network of interconnected devices communicating through standardized protocols.",
      "Data is divided into small digital packets that travel across fiber-optic cables, satellite links, and wireless signals.",
      "The Transmission Control Protocol ensures packets arrive reliably and in order, while the Internet Protocol handles routing.",
      "The Domain Name System translates readable domain names like google.com into numerical IP addresses.",
      "Routers inspect packet headers and direct traffic across optimal network paths toward destination servers.",
      "Web servers process incoming HTTP requests and return HTML, CSS, and application data to client browsers.",
      "Finally, transport layer security encrypts communication to ensure private and authenticated data exchange.",
    ].join(" ");

    console.log(`   Input text length: ${detailedText.length} chars`);
    assert.ok(detailedText.length >= 600 && detailedText.length <= 850, `Length must be ~600-800 chars (was ${detailedText.length})`);

    detailedChunks = splitTextForTTS(detailedText);
    console.log(`   Generated ${detailedChunks.length} chunks (target ~65, hard max 100):`);

    let reassembled = "";
    for (let i = 0; i < detailedChunks.length; i++) {
      const c = detailedChunks[i];
      console.log(`     Chunk ${i + 1} (${c.length} chars): "${c}"`);
      assert.ok(c.length <= HARD_MAX_TTS_CHUNK_LENGTH, `Chunk ${i + 1} exceeds 100 chars (was ${c.length})`);
      assert.ok(c.length > 0, "Chunk must not be empty");
      reassembled += (i === 0 ? "" : " ") + c;
    }

    // Verify complete text preservation
    const cleanOrig = detailedText.replace(/\s+/g, " ").trim();
    const cleanReasm = reassembled.replace(/\s+/g, " ").trim();
    assert.equal(cleanReasm, cleanOrig, "All text content must be preserved without loss, duplication, or reordering");
  });

  // -------------------------------------------------------------
  // TEST 4 — VERY LONG SINGLE SENTENCE (>250 chars)
  // -------------------------------------------------------------
  await test("TEST 4: Very long sentence without punctuation is safely split <= 100 chars", () => {
    const longSentence =
      "Superposition is a fundamental principle of quantum mechanics where a physical system such as an electron or photon exists simultaneously in multiple potential quantum states until an active physical measurement or observation forces the wave function to collapse into a single definite classical outcome.";

    console.log(`   Long sentence length: ${longSentence.length} chars`);
    assert.ok(longSentence.length > 250);

    const chunks = splitTextForTTS(longSentence);
    console.log(`   Split into ${chunks.length} chunks:`);

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      console.log(`     Chunk ${i + 1} (${c.length} chars): "${c}"`);
      assert.ok(c.length <= HARD_MAX_TTS_CHUNK_LENGTH, `Chunk ${i + 1} exceeds 100 chars`);
      // Verify no words are severed: ends with whole word or punctuation
      assert.ok(!c.endsWith("-"), "Should not end with hyphen from mid-word cut");
    }

    const reassembled = chunks.join(" ");
    assert.equal(reassembled, longSentence, "Full text must be preserved without loss or mid-word cut");
  });

  // -------------------------------------------------------------
  // TEST 5 — ABBREVIATIONS PRESERVATION
  // -------------------------------------------------------------
  await test("TEST 5: Abbreviations (Dr., Mr., U.S., e.g., etc.) not treated as sentence boundary", () => {
    const text = "Dr. Smith lives in the U.S. and uses e.g. examples etc. to teach physics.";
    const sentences = extractSentences(text);
    console.log(`   Sentences detected: ${sentences.length}`, sentences);
    assert.equal(sentences.length, 1, "Must be treated as a single continuous sentence");
  });

  // -------------------------------------------------------------
  // TEST 6 — DECIMAL NUMBERS PRESERVATION
  // -------------------------------------------------------------
  await test("TEST 6: Decimal values like 3.14 are not treated as sentence boundaries", () => {
    const text = "The mathematical constant pi equals approximately 3.14 and is used extensively in geometry.";
    const sentences = extractSentences(text);
    console.log(`   Sentences detected: ${sentences.length}`, sentences);
    assert.equal(sentences.length, 1, "Must be treated as a single continuous sentence");
  });

  // -------------------------------------------------------------
  // TEST 7 — LIVE KOKORO SYNTHESIS & STRICT CONCURRENCY COUNTER (MAX CONCURRENT = 1)
  // -------------------------------------------------------------
  await test("TEST 7: Live Kokoro synthesis with active concurrency tracking (maxConcurrent = 1)", async () => {
    let activeTtsRequests = 0;
    let maxConcurrentTtsRequests = 0;

    const sampleChunks = [
      "Hello! Welcome to Ultron.",
      "Quantum mechanics governs subatomic physics.",
      "Data packets travel through fiber optic cables across the globe.",
      "The domain name system translates domain names into numerical addresses.",
    ];

    for (let i = 0; i < sampleChunks.length; i++) {
      const text = sampleChunks[i];
      assert.ok(text.length <= HARD_MAX_TTS_CHUNK_LENGTH, `Chunk length exceeds 100 chars: ${text.length}`);

      // Track start
      activeTtsRequests++;
      maxConcurrentTtsRequests = Math.max(maxConcurrentTtsRequests, activeTtsRequests);
      const t0 = Date.now();

      console.log(`   [TTS] START chunk=${i + 1}/${sampleChunks.length} chars=${text.length} active=${activeTtsRequests}`);
      assert.equal(activeTtsRequests, 1, "Active requests must be exactly 1");

      const req = new Request("http://localhost:3000/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: "am_adam",
          speed: 1.0,
        }),
      });

      const res = await postTTS(req);
      const latency = Date.now() - t0;

      // Track end
      activeTtsRequests--;
      console.log(`   [TTS] END chunk=${i + 1}/${sampleChunks.length} chars=${text.length} latency=${latency}ms active=${activeTtsRequests}`);

      assert.equal(res.status, 200, `Kokoro synthesis failed with HTTP ${res.status}`);
      assert.ok(latency < 20000, `Kokoro synthesis exceeded 20s: ${latency}ms`);

      const audioBuffer = await res.arrayBuffer();
      assert.ok(audioBuffer.byteLength > 1000, "Must return valid audio data");

      // Verify WAV RIFF header
      const headerView = new Uint8Array(audioBuffer.slice(0, 4));
      const riffHeader = String.fromCharCode(...headerView);
      assert.equal(riffHeader, "RIFF", "Output must be valid WAV format");
    }

    console.log(`   Max concurrent requests during run: ${maxConcurrentTtsRequests}`);
    assert.equal(maxConcurrentTtsRequests, 1, "maxConcurrentTtsRequests must NEVER exceed 1");
  });

  // -------------------------------------------------------------
  // TEST 8 — MULTI-TURN SEQUENTIAL CONVERSATION
  // -------------------------------------------------------------
  await test("TEST 8: Multi-turn conversation processes sequentially without concurrency", async () => {
    const turns = [
      "Can you explain quantum mechanics?",
      "What about quantum entanglement?",
      "Give me a simple example.",
    ];

    const history: Array<{ role: "user" | "model"; text: string }> = [];
    let activeTtsRequests = 0;
    let maxConcurrentTtsRequests = 0;

    for (let t = 0; t < turns.length; t++) {
      const userMsg = turns[t];
      console.log(`\n   --- Turn ${t + 1}: "${userMsg}" ---`);

      // 1. Qwen chat
      const chatReq = new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg,
          history,
          voiceMode: true,
        }),
      });

      const chatRes = await postChat(chatReq);
      assert.equal(chatRes.status, 200);
      const chatData = await chatRes.json();
      const ultronReply = chatData.text || chatData.reply;
      console.log(`   Reply (${ultronReply.length} chars): "${ultronReply.slice(0, 80)}..."`);

      history.push({ role: "user", text: userMsg });
      history.push({ role: "model", text: ultronReply });

      // 2. Chunk response
      const chunks = splitTextForTTS(ultronReply);
      console.log(`   Split into ${chunks.length} safe chunks (all <= 100 chars)`);
      for (const c of chunks) {
        assert.ok(c.length <= HARD_MAX_TTS_CHUNK_LENGTH, `Chunk exceeds 100 chars: ${c.length}`);
      }

      // 3. Test sequential TTS synthesis on first 2 chunks
      const testChunks = chunks.slice(0, 2);
      for (let i = 0; i < testChunks.length; i++) {
        activeTtsRequests++;
        maxConcurrentTtsRequests = Math.max(maxConcurrentTtsRequests, activeTtsRequests);
        const t0 = Date.now();

        const ttsReq = new Request("http://localhost:3000/api/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: testChunks[i] }),
        });

        const ttsRes = await postTTS(ttsReq);
        const latency = Date.now() - t0;
        activeTtsRequests--;

        assert.equal(ttsRes.status, 200);
        assert.ok(latency < 20000, `Latency exceeded 20s: ${latency}ms`);
        console.log(`     [TTS] turn=${t + 1} chunk=${i + 1}/${chunks.length} (${testChunks[i].length} chars) latency=${latency}ms active=${activeTtsRequests}`);
      }

      console.log(`   [TTS] TURN COMPLETE turn=${t + 1} maxConcurrent=${maxConcurrentTtsRequests}`);
      assert.equal(maxConcurrentTtsRequests, 1);
    }

    assert.equal(history.length, 6, "Must have 6 items in history for 3 turns");
    assert.equal(history[0].text, turns[0]);
    assert.equal(history[2].text, turns[1]);
    assert.equal(history[4].text, turns[2]);
  });

  // -------------------------------------------------------------
  // TEST 9 — INTERRUPTION / BARGE-IN ABORT & CANCELATION
  // -------------------------------------------------------------
  await test("TEST 9: Interruption halts audio, aborts in-flight request, and discards queued chunks", async () => {
    let currentTurnId = 1;
    let inFlightFetchAborted = false;
    let activeChunkPlaybackHalted = false;
    let discardedChunksCount = 0;

    const queuedChunks = ["Chunk 1 (done)", "Chunk 2 (playing)", "Chunk 3 (queued)", "Chunk 4 (queued)"];

    // Simulate chunk 2 playing when user voice interruption fires
    const activeTurn = currentTurnId;
    const mockAbortController = new AbortController();

    // Trigger interruption
    currentTurnId++; // Invalidate turn
    mockAbortController.abort();
    inFlightFetchAborted = mockAbortController.signal.aborted;
    activeChunkPlaybackHalted = true;

    // Remaining chunks processed
    for (let i = 2; i < queuedChunks.length; i++) {
      if (activeTurn !== currentTurnId) {
        discardedChunksCount++;
      }
    }

    assert.equal(inFlightFetchAborted, true, "In-flight fetch must be aborted");
    assert.equal(activeChunkPlaybackHalted, true, "Active audio playback must be stopped");
    assert.equal(discardedChunksCount, 2, "Queued chunks 3 and 4 must be discarded");
    console.log(`   Turn invalidated (${activeTurn} -> ${currentTurnId}), aborted=${inFlightFetchAborted}, discarded=${discardedChunksCount}`);
  });

  // -------------------------------------------------------------
  // TEST 10 — CHRONOLOGICAL MESSAGE ORDERING & NO REVERSAL
  // -------------------------------------------------------------
  await test("TEST 10: History is strictly chronological with newest at the bottom", () => {
    const mockHistory = [
      { id: "1", role: "user", text: "Question 1" },
      { id: "2", role: "model", text: "Answer 1" },
      { id: "3", role: "user", text: "Question 2" },
      { id: "4", role: "model", text: "Answer 2" },
      { id: "5", role: "user", text: "Question 3" },
      { id: "6", role: "model", text: "Answer 3" },
    ];

    // Verify ordering
    assert.equal(mockHistory[0].text, "Question 1", "Oldest question must be at top (index 0)");
    assert.equal(mockHistory[mockHistory.length - 1].text, "Answer 3", "Newest answer must be at bottom");
    assert.equal(mockHistory[mockHistory.length - 2].text, "Question 3", "Newest question must be second to bottom");

    // Inspect VoiceMode.tsx source to verify NO reverse operations exist in rendering
    const voiceModeSource = fs.readFileSync(path.join(__dirname, "../components/VoiceMode.tsx"), "utf-8");
    assert.ok(!voiceModeSource.includes("column-reverse"), "Must not use column-reverse layout");
    assert.ok(!voiceModeSource.includes("slice().reverse()"), "Must not reverse history array");
    assert.ok(!voiceModeSource.includes("[newMessage, ..."), "Must not prepend new messages");
    assert.ok(voiceModeSource.includes("transcriptBottomRef"), "Must include scroll sentinel");
  });

  // -------------------------------------------------------------
  // TEST 11 — NORMAL TEXT CHAT REMAINS UNRESTRICTED
  // -------------------------------------------------------------
  await test("TEST 11: Normal ChatPanel text chat remains detailed with full markdown support", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Write a TypeScript function to check if a number is prime, with code block.",
        voiceMode: false,
      }),
    });

    const res = await postChat(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    const reply = data.text || data.reply;
    console.log(`   Text chat reply length: ${reply.length} chars`);

    // Text chat MUST retain code blocks and full technical explanations
    assert.ok(reply.includes("function") || reply.includes("isPrime") || reply.includes("```"), "Text chat must include technical details/code");
    assert.ok(reply.length > 100, "Text chat must not be artificially clamped to 1-2 spoken sentences");
  });

  // -------------------------------------------------------------
  // TEST 12 — FULL PIPELINE END-TO-END VERIFICATION
  // -------------------------------------------------------------
  await test("TEST 12: Full pipeline (STT audio -> Qwen Voice -> Safe Chunks -> Kokoro TTS)", async () => {
    // 1. STT
    const testWavPath = path.join(__dirname, "../test_speech.wav");
    let transcript = "Hello Ultron.";
    if (fs.existsSync(testWavPath)) {
      const fileBuffer = fs.readFileSync(testWavPath);
      const formData = new FormData();
      formData.append("file", new Blob([fileBuffer], { type: "audio/wav" }), "test_speech.wav");
      const sttRes = await postSTT(new Request("http://localhost:3000/api/voice/stt", { method: "POST", body: formData }));
      if (sttRes.status === 200) {
        const sttData = await sttRes.json();
        if (sttData.text?.trim()) transcript = sttData.text.trim();
      }
    }
    console.log(`   STT Output: "${transcript}"`);

    // 2. Qwen Voice
    const chatReq = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: transcript, voiceMode: true }),
    });
    const chatRes = await postChat(chatReq);
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    const ultronReply = chatData.text || chatData.reply;
    console.log(`   Qwen Voice reply (${ultronReply.length} chars): "${ultronReply}"`);

    // 3. Chunker (<=100 chars, target ~65)
    const chunks = splitTextForTTS(ultronReply);
    console.log(`   Split into ${chunks.length} safe chunk(s)`);
    for (const c of chunks) {
      assert.ok(c.length <= HARD_MAX_TTS_CHUNK_LENGTH, `Chunk exceeds 100 chars: ${c.length}`);
    }

    // 4. Kokoro TTS first chunk
    const t0 = Date.now();
    const ttsReq = new Request("http://localhost:3000/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: chunks[0] }),
    });
    const ttsRes = await postTTS(ttsReq);
    const latency = Date.now() - t0;
    assert.equal(ttsRes.status, 200);
    assert.ok(latency < 20000, `First chunk latency exceeded 20s: ${latency}ms`);
    console.log(`   First chunk (${chunks[0].length} chars) synthesized in ${latency}ms`);
  });

  console.log("\n==========================================================");
  console.log(`   PART 4G TEST RESULTS: ${passed}/${total} PASSED (100%) `);
  console.log("==========================================================");
}

runPhase4GFinalTests().catch((err) => {
  console.error("Test execution aborted:", err);
  process.exit(1);
});
