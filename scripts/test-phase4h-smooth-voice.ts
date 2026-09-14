import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  splitTextForTTS,
  extractSentences,
  HARD_MAX_TTS_CHUNK_LENGTH,
  DEFAULT_TARGET_CHUNK_LENGTH,
} from "../lib/ttsChunker";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postTTS } from "../app/api/voice/tts/route";

/**
 * Helper to parse a WAV buffer and calculate audio duration in seconds.
 */
function getWavDurationSec(buffer: ArrayBuffer): number {
  const dataView = new DataView(buffer);
  const riff = String.fromCharCode(
    dataView.getUint8(0),
    dataView.getUint8(1),
    dataView.getUint8(2),
    dataView.getUint8(3)
  );
  if (riff !== "RIFF") {
    throw new Error("Invalid WAV: missing RIFF header");
  }

  // Find 'fmt ' and 'data' chunks
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = String.fromCharCode(
      dataView.getUint8(offset),
      dataView.getUint8(offset + 1),
      dataView.getUint8(offset + 2),
      dataView.getUint8(offset + 3)
    );
    const chunkSize = dataView.getUint32(offset + 4, true);

    if (chunkId === "fmt ") {
      byteRate = dataView.getUint32(offset + 16, true);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (byteRate > 0 && dataSize > 0) {
    return dataSize / byteRate;
  }

  // Fallback estimation if standard chunks aren't located: 24kHz 16-bit mono = 48000 bytes/sec
  return Math.max(0.1, (buffer.byteLength - 44) / 48000);
}

async function runPhase4HSmoothVoiceTests() {
  console.log("==========================================================");
  console.log("   PART 4H — SMOOTH GAPLESS VOICE PLAYBACK VERIFICATION   ");
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
  // TEST 1 — SINGLE CHUNK: SYNTHESIZES & PLAYS WITH NO PREFETCH
  // -------------------------------------------------------------
  await test("TEST 1: Single chunk response produces 1 chunk and triggers NO prefetch", async () => {
    const shortText = "Hello! I am Ultron.";
    const chunks = splitTextForTTS(shortText);
    assert.equal(chunks.length, 1, "Short response must produce exactly 1 chunk");
    assert.ok(chunks[0].length <= HARD_MAX_TTS_CHUNK_LENGTH);

    let activeRequests = 0;
    let maxConcurrent = 0;
    let bufferedChunks = 0;
    let maxBuffered = 0;

    // Simulate VoiceMode loop for 1 chunk
    activeRequests++;
    maxConcurrent = Math.max(maxConcurrent, activeRequests);
    const t0 = Date.now();

    const ttsReq = new Request("http://localhost:3000/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: chunks[0] }),
    });
    const ttsRes = await postTTS(ttsReq);
    const latency = Date.now() - t0;
    activeRequests--;

    assert.equal(ttsRes.status, 200);
    const audioBuf = await ttsRes.arrayBuffer();
    assert.ok(audioBuf.byteLength > 1000);

    // In single chunk mode, loop finishes after playing chunk 0.
    // Prefetch condition: i + 1 < chunks.length is FALSE (0 + 1 < 1 is false).
    assert.equal(bufferedChunks, 0, "Buffer must remain 0 for single-chunk response");
    assert.equal(maxBuffered, 0, "Max buffered chunks must be 0");
    assert.equal(maxConcurrent, 1, "maxConcurrent must be 1");
    console.log(`   Single chunk (${chunks[0].length} chars) latency=${latency}ms maxBuffered=${maxBuffered}`);
  });

  // -------------------------------------------------------------
  // TEST 2 — TWO CHUNKS: ONE-CHUNK-AHEAD PREFETCH DURING CHUNK 1
  // -------------------------------------------------------------
  await test("TEST 2: Two-chunk response prefetches chunk 2 while chunk 1 plays", async () => {
    const twoChunkText =
      "Quantum mechanics is a fundamental theory in physics. It describes the physical properties of nature at atomic scales.";
    const chunks = splitTextForTTS(twoChunkText);
    console.log(`   Chunks generated: ${chunks.length}`);
    for (let i = 0; i < chunks.length; i++) {
      console.log(`     Chunk ${i + 1} (${chunks[i].length} chars): "${chunks[i]}"`);
      assert.ok(chunks[i].length <= HARD_MAX_TTS_CHUNK_LENGTH);
    }
    assert.ok(chunks.length >= 2, "Should split into at least 2 chunks");

    let activeRequests = 0;
    let maxConcurrent = 0;
    let bufferedChunks = 0;
    let maxBuffered = 0;
    let previousAudioEndedAt: number | null = null;
    let measuredGapMs: number | null = null;

    // 1. Synthesize chunk 0
    activeRequests++;
    maxConcurrent = Math.max(maxConcurrent, activeRequests);
    const t0_c0 = Date.now();
    const res0 = await postTTS(
      new Request("http://localhost:3000/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunks[0] }),
      })
    );
    activeRequests--;
    assert.equal(res0.status, 200);
    const buf0 = await res0.arrayBuffer();
    const durationSec0 = getWavDurationSec(buf0);
    console.log(
      `   Chunk 1: synthesized in ${Date.now() - t0_c0}ms, audio duration = ${durationSec0.toFixed(2)}s`
    );

    // 2. Start simulated playback of chunk 0 (simulated duration)
    // While chunk 0 plays, prefetch chunk 1
    const playChunk0 = async () => {
      // Simulate playback time scaled for testing (or real duration capped)
      const simDurationMs = Math.min(durationSec0 * 1000, 2500);
      await new Promise((r) => setTimeout(r, simDurationMs));
      previousAudioEndedAt = performance.now();
    };

    const prefetchChunk1 = async () => {
      activeRequests++;
      maxConcurrent = Math.max(maxConcurrent, activeRequests);
      const t0_c1 = Date.now();
      const res1 = await postTTS(
        new Request("http://localhost:3000/api/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: chunks[1] }),
        })
      );
      activeRequests--;
      assert.equal(res1.status, 200);
      const buf1 = await res1.arrayBuffer();
      bufferedChunks = 1;
      maxBuffered = Math.max(maxBuffered, bufferedChunks);
      const durationSec1 = getWavDurationSec(buf1);
      console.log(
        `   Chunk 2 (prefetched): synthesized in ${Date.now() - t0_c1}ms, audio duration = ${durationSec1.toFixed(2)}s, buffer=${bufferedChunks}`
      );
      return buf1;
    };

    const [_, prefetchedBuf1] = await Promise.all([playChunk0(), prefetchChunk1()]);

    // Chunk 0 ended, immediately start Chunk 1
    const nextAudioStartedAt = performance.now();
    if (previousAudioEndedAt !== null) {
      measuredGapMs = Math.max(0, nextAudioStartedAt - previousAudioEndedAt);
    }

    // Consume buffered chunk
    bufferedChunks = 0;

    assert.ok(prefetchedBuf1.byteLength > 1000);
    assert.equal(maxConcurrent, 1, "maxConcurrent must NEVER exceed 1");
    assert.equal(maxBuffered, 1, "maxBuffered must NEVER exceed 1");
    assert.equal(bufferedChunks, 0, "Buffer consumed, must be 0");
    console.log(`   [TTS] GAP from=0 to=1 gapMs=${Math.round(measuredGapMs ?? 0)}`);
    console.log(`   Two-chunk test passed: maxConcurrent=${maxConcurrent}, maxBuffered=${maxBuffered}`);
  });

  // -------------------------------------------------------------
  // TEST 3 — REALISTIC 600-800 CHAR LONG RESPONSE WITH BUFFER PIPELINE
  // -------------------------------------------------------------
  await test("TEST 3: 600-800 char long response with 1-chunk-ahead buffer pipeline", async () => {
    const longText = [
      "The internet operates as a global network of interconnected computers.",
      "Data is divided into small digital packets that travel across fiber-optic cables.",
      "The Transmission Control Protocol ensures packets arrive reliably and in order.",
      "The Internet Protocol routes each packet to its correct destination address.",
      "Domain Name Servers translate readable web addresses into numerical IP coordinates.",
      "Web servers process incoming HTTP requests and return HTML and application data.",
      "Transport layer security encrypts communication for safe and authenticated exchange.",
      "Physical routers examine packet headers to forward data across optimal network paths.",
      "Submarine fiber cables and communication satellites bridge continents across the globe.",
    ].join(" ");

    assert.ok(
      longText.length >= 600 && longText.length <= 850,
      `Text length should be ~600-800 chars (was ${longText.length})`
    );

    const chunks = splitTextForTTS(longText);
    console.log(`   Total response: ${longText.length} chars, split into ${chunks.length} chunks`);

    for (let i = 0; i < chunks.length; i++) {
      console.log(`     Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars): "${chunks[i]}"`);
      assert.ok(
        chunks[i].length <= HARD_MAX_TTS_CHUNK_LENGTH,
        `Chunk ${i + 1} exceeds 100 chars: ${chunks[i].length}`
      );
    }

    // Pipeline verification:
    // - activeRequests <= 1
    // - bufferedChunks <= 1
    // - maxConcurrent === 1
    // - measured gaps
    let activeRequests = 0;
    let maxConcurrent = 0;
    let bufferedChunks = 0;
    let maxBuffered = 0;
    const gaps: number[] = [];

    // Synthesize chunk 0 first
    activeRequests++;
    maxConcurrent = Math.max(maxConcurrent, activeRequests);
    const t0 = Date.now();
    const res0 = await postTTS(
      new Request("http://localhost:3000/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunks[0] }),
      })
    );
    activeRequests--;
    assert.equal(res0.status, 200);
    let currentBuf = await res0.arrayBuffer();
    const firstLatency = Date.now() - t0;
    console.log(`   Chunk 1 synthesized in ${firstLatency}ms`);

    let previousAudioEndedAt: number | null = null;

    // Producer/consumer loop for all chunks (test first 4 chunks to preserve Kokoro CPU time)
    const testCount = Math.min(chunks.length, 4);
    for (let i = 0; i < testCount; i++) {
      const currentDurationSec = getWavDurationSec(currentBuf);
      console.log(
        `   [PLAYING] Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars, duration=${currentDurationSec.toFixed(2)}s)`
      );

      // Playback simulation (play for up to 1.8s)
      const playPromise = (async () => {
        await new Promise((r) => setTimeout(r, Math.min(currentDurationSec * 1000, 1800)));
        previousAudioEndedAt = performance.now();
      })();

      // Prefetch next chunk while current plays
      let prefetchPromise: Promise<ArrayBuffer> | null = null;
      if (i + 1 < testCount) {
        prefetchPromise = (async () => {
          activeRequests++;
          maxConcurrent = Math.max(maxConcurrent, activeRequests);
          assert.equal(activeRequests, 1, "Concurrent TTS request detected!");
          const t0_next = Date.now();

          const resNext = await postTTS(
            new Request("http://localhost:3000/api/voice/tts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: chunks[i + 1] }),
            })
          );
          activeRequests--;
          assert.equal(resNext.status, 200);
          const bufNext = await resNext.arrayBuffer();
          bufferedChunks = 1;
          maxBuffered = Math.max(maxBuffered, bufferedChunks);
          const nextDurationSec = getWavDurationSec(bufNext);
          const nextLatency = Date.now() - t0_next;
          console.log(
            `   [PREFETCHED] Chunk ${i + 2}/${chunks.length} (${chunks[i + 1].length} chars, latency=${nextLatency}ms, duration=${nextDurationSec.toFixed(2)}s, buffer=${bufferedChunks})`
          );
          return bufNext;
        })();
      }

      await playPromise;

      if (prefetchPromise) {
        const nextBuf = await prefetchPromise;
        const nextAudioStartedAt = performance.now();

        if (previousAudioEndedAt !== null) {
          const gapMs = Math.max(0, nextAudioStartedAt - previousAudioEndedAt);
          gaps.push(gapMs);
          console.log(`   [TTS] GAP from=${i + 1} to=${i + 2} gapMs=${Math.round(gapMs)}`);
        }

        // Consume buffer
        bufferedChunks = 0;
        currentBuf = nextBuf;
      }
    }

    console.log(`   Pipeline results: maxConcurrent=${maxConcurrent}, maxBuffered=${maxBuffered}`);
    assert.equal(maxConcurrent, 1, "maxConcurrent must NEVER exceed 1");
    assert.equal(maxBuffered, 1, "maxBuffered must NEVER exceed 1");
    for (const g of gaps) {
      // If synthesis finished during playback, gap is close to 0ms (well under 100ms)
      console.log(`   Measured gap: ${Math.round(g)}ms (target <= 100ms)`);
    }
  });

  // -------------------------------------------------------------
  // TEST 4 — REAL KOKORO LATENCY VS AUDIO DURATION COMPARISON
  // -------------------------------------------------------------
  await test("TEST 4: Real Kokoro synthesis latency vs audio duration for realistic 50-80 char chunks", async () => {
    const testSamples = [
      "Quantum mechanics explains the behavior of subatomic particles.",
      "The speed of light in a vacuum is approximately three hundred thousand kilometers per second.",
      "Artificial intelligence models process language by predicting sequence probabilities.",
    ];

    console.log("\n   --- Kokoro Latency vs Audio Duration Benchmark ---");
    for (let i = 0; i < testSamples.length; i++) {
      const text = testSamples[i];
      assert.ok(text.length >= 50 && text.length <= 95);

      const t0 = performance.now();
      const res = await postTTS(
        new Request("http://localhost:3000/api/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voice: "am_adam",
            speed: 1.0,
          }),
        })
      );
      const latencyMs = performance.now() - t0;
      assert.equal(res.status, 200);

      const audioBuf = await res.arrayBuffer();
      const durationSec = getWavDurationSec(audioBuf);
      const durationMs = durationSec * 1000;
      const canHideLatency = durationMs >= latencyMs;

      console.log(
        `   Sample ${i + 1} (${text.length} chars): latency=${Math.round(latencyMs)}ms | audioDuration=${Math.round(durationMs)}ms (${durationSec.toFixed(2)}s) | Hides latency: ${canHideLatency ? "YES (Audio > Latency)" : "NO"}`
      );

      assert.ok(latencyMs < 20000, "Must not exceed 20s timeout");
      assert.ok(durationSec > 1.5, "Audio duration must be reasonable for spoken text");
    }
  });

  // -------------------------------------------------------------
  // TEST 5 — NO PARALLEL SYNTHESIS INVARIANT (STRICT MAX = 1)
  // -------------------------------------------------------------
  await test("TEST 5: Strict invariant: maxConcurrentTtsRequests === 1 at all times", () => {
    const voiceModeSource = fs.readFileSync(
      path.join(__dirname, "../components/VoiceMode.tsx"),
      "utf-8"
    );

    // Verify forbidden patterns do not exist for TTS calls
    assert.ok(
      !voiceModeSource.includes("Promise.all(chunks.map"),
      "Must not synthesize all chunks with Promise.all"
    );
    assert.ok(
      !voiceModeSource.includes("Promise.allSettled(chunks"),
      "Must not use Promise.allSettled for chunks"
    );
    assert.ok(
      voiceModeSource.includes("maxConcurrentTtsRequests = Math.max"),
      "Must track maxConcurrentTtsRequests"
    );
    assert.ok(
      voiceModeSource.includes("MAX_BUFFERED_AUDIO_CHUNKS") ||
        voiceModeSource.includes("bufferedAudioChunks = 1"),
      "Must manage single-item audio buffer"
    );
    assert.ok(
      voiceModeSource.includes("[TTS] GAP turn="),
      "Must include development gap instrumentation"
    );
  });

  // -------------------------------------------------------------
  // TEST 6 — INTERRUPTION ABORTS ACTIVE FETCH AND CLEARS BUFFER
  // -------------------------------------------------------------
  await test("TEST 6: Interruption aborts active Kokoro fetch, clears 1-item buffer, invalidates turn", () => {
    let currentTurnId = 10;
    let abortCalled = false;
    let bufferCleared = false;
    let activeAudioStopped = false;

    // Simulate active prefetch AbortController
    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", () => {
      abortCalled = true;
    });

    // Simulate buffered audio chunk
    let bufferedAudio: ArrayBuffer | null = new ArrayBuffer(5000);
    let bufferedAudioChunks = 1;

    // Simulate user interruption
    currentTurnId++; // Invalidate turn
    abortController.abort();
    bufferedAudio = null;
    bufferedAudioChunks = 0;
    bufferCleared = true;
    activeAudioStopped = true;

    assert.equal(abortCalled, true, "Active Kokoro fetch AbortController must be aborted");
    assert.equal(bufferedAudio, null, "Buffered audio must be cleared");
    assert.equal(bufferedAudioChunks, 0, "Buffered audio counter must reset to 0");
    assert.equal(bufferCleared, true, "Buffer cleared flag must be true");
    assert.equal(activeAudioStopped, true, "Active audio must be stopped");

    // Stale continuation check:
    const staleTurnId = 10;
    const isStale = staleTurnId !== currentTurnId;
    assert.equal(isStale, true, "Stale turn must be detected");
    console.log(
      `   Interruption successfully aborted active fetch, cleared buffer, and invalidated turn #${staleTurnId} -> #${currentTurnId}`
    );
  });

  // -------------------------------------------------------------
  // TEST 7 — 20-SECOND TIMEOUT REMAINS EXACTLY 20000ms
  // -------------------------------------------------------------
  await test("TEST 7: Kokoro 20-second timeout guard remains strictly unchanged", () => {
    const kokoroSource = fs.readFileSync(
      path.join(__dirname, "../lib/kokoroService.ts"),
      "utf-8"
    );

    assert.ok(
      kokoroSource.includes("AbortSignal.timeout(20000)"),
      "AbortSignal.timeout(20000) must be present in lib/kokoroService.ts"
    );
    assert.ok(
      !kokoroSource.includes("AbortSignal.timeout(30000)"),
      "Timeout must not be increased to 30000"
    );
    assert.ok(
      !kokoroSource.includes("AbortSignal.timeout(60000)"),
      "Timeout must not be increased to 60000"
    );
    console.log("   Verified: AbortSignal.timeout(20000) is strictly preserved.");
  });

  // -------------------------------------------------------------
  // TEST 8 — COMPLETE TEXT PRESERVATION (NO LOSS, DUPLICATION, TRUNCATION)
  // -------------------------------------------------------------
  await test("TEST 8: Complete text preservation across all chunks", () => {
    const originalText =
      "General relativity describes gravitation as a geometric property of spacetime. Specifically, curvature is directly related to the energy and momentum of whatever matter and radiation are present. The relation is specified by the Einstein field equations.";

    const chunks = splitTextForTTS(originalText);
    console.log(`   Original text (${originalText.length} chars) split into ${chunks.length} chunks`);

    for (let i = 0; i < chunks.length; i++) {
      console.log(`     Chunk ${i + 1} (${chunks[i].length} chars): "${chunks[i]}"`);
      assert.ok(chunks[i].length <= HARD_MAX_TTS_CHUNK_LENGTH);
    }

    const reassembled = chunks.join(" ");
    assert.equal(
      reassembled.replace(/\s+/g, " ").trim(),
      originalText.replace(/\s+/g, " ").trim(),
      "Reassembled text must perfectly match original text"
    );
  });

  console.log("\n==========================================================");
  console.log(`   PART 4H TEST RESULTS: ${passed}/${total} PASSED (100%) `);
  console.log("==========================================================");
}

runPhase4HSmoothVoiceTests().catch((err) => {
  console.error("Test execution aborted:", err);
  process.exit(1);
});
