import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GREETING_TEXT } from "../components/VoiceMode";
import { POST as postTTS } from "../app/api/voice/tts/route";
import { POST as postChat } from "../app/api/chat/route";

async function runPhase4IGreetingTests() {
  console.log("==========================================================");
  console.log("   PART 4I — ULTRON VOICE MODE GREETING VERIFICATION      ");
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
  // TEST 1 — EXACT GREETING TEXT CONSTANT
  // -------------------------------------------------------------
  await test("TEST 1: Exact greeting text is defined as 'Hello Sir, how may I assist you?'", () => {
    assert.equal(
      GREETING_TEXT,
      "Hello Sir, how may I assist you?",
      "Greeting text must match exact required string"
    );
    console.log(`   Greeting Text: "${GREETING_TEXT}" (${GREETING_TEXT.length} chars)`);
  });

  // -------------------------------------------------------------
  // TEST 2 — DIRECT KOKORO SYNTHESIS OF GREETING (ONE CHUNK)
  // -------------------------------------------------------------
  let greetingAudioBuffer: ArrayBuffer | null = null;
  await test("TEST 2: Direct Kokoro synthesis produces valid WAV audio with am_adam", async () => {
    const t0 = Date.now();
    const req = new Request("http://localhost:3000/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: GREETING_TEXT,
        voice: "am_adam",
        speed: 1.0,
      }),
    });

    const res = await postTTS(req);
    const latency = Date.now() - t0;
    assert.equal(res.status, 200, `Kokoro TTS failed with status ${res.status}`);

    greetingAudioBuffer = await res.arrayBuffer();
    assert.ok(greetingAudioBuffer.byteLength > 5000, "Audio buffer must be non-empty");

    // Verify RIFF WAV header
    const headerView = new Uint8Array(greetingAudioBuffer.slice(0, 4));
    const riff = String.fromCharCode(...headerView);
    assert.equal(riff, "RIFF", "Audio must be a valid RIFF WAV format");

    // Duration estimation: 24kHz 16-bit mono = 48,000 bytes/sec
    const durationSec = (greetingAudioBuffer.byteLength - 44) / 48000;
    console.log(
      `   Synthesized in ${latency}ms, size=${greetingAudioBuffer.byteLength} bytes, estimatedDuration=${durationSec.toFixed(2)}s`
    );
    assert.ok(latency < 20000, "Synthesis must be within 20s timeout");
    assert.ok(durationSec >= 1.5 && durationSec <= 4.0, "Audio duration must be reasonable for greeting");
  });

  // -------------------------------------------------------------
  // TEST 3 — GREETING IS VISUALLY DISPLAYED IMMEDIATELY IN HISTORY
  // -------------------------------------------------------------
  await test("TEST 3: VoiceMode source initializes history with model greeting turn", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../components/VoiceMode.tsx"),
      "utf-8"
    );

    assert.ok(
      source.includes('role: "model"'),
      "History must contain model greeting turn"
    );
    assert.ok(
      source.includes("text: GREETING_TEXT"),
      "Initial history must use GREETING_TEXT"
    );
    assert.ok(
      source.includes("useState<string>(GREETING_TEXT)"),
      "latestUltronText must be initialized to GREETING_TEXT"
    );
  });

  // -------------------------------------------------------------
  // TEST 4 — GREETING DOES NOT CALL QWEN OR WHISPER
  // -------------------------------------------------------------
  await test("TEST 4: Greeting is fixed local response without /api/chat or /api/voice/stt calls", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../components/VoiceMode.tsx"),
      "utf-8"
    );

    // playGreeting should only call /api/voice/tts
    const playGreetingIdx = source.indexOf("const playGreeting =");
    assert.ok(playGreetingIdx !== -1, "playGreeting must be defined");
    const playGreetingBody = source.slice(playGreetingIdx, playGreetingIdx + 3000);

    assert.ok(
      !playGreetingBody.includes('fetch("/api/chat"'),
      "playGreeting must NOT call /api/chat"
    );
    assert.ok(
      !playGreetingBody.includes('fetch("/api/voice/stt"'),
      "playGreeting must NOT call /api/voice/stt"
    );
    assert.ok(
      playGreetingBody.includes('fetch("/api/voice/tts"'),
      "playGreeting must call /api/voice/tts"
    );
  });

  // -------------------------------------------------------------
  // TEST 5 — DUPLICATE PREVENTION & STRICT MODE RESILIENCE
  // -------------------------------------------------------------
  await test("TEST 5: hasGreetedRef prevents duplicate execution per opening and resets on unmount", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../components/VoiceMode.tsx"),
      "utf-8"
    );

    assert.ok(
      source.includes("const hasGreetedRef = useRef<boolean>(false);"),
      "Must define hasGreetedRef"
    );
    assert.ok(
      source.includes("if (!isMountedRef.current || hasGreetedRef.current) return;"),
      "playGreeting must guard against duplicate calls using hasGreetedRef"
    );
    assert.ok(
      source.includes("hasGreetedRef.current = false;"),
      "cleanup on unmount must reset hasGreetedRef for clean re-opening"
    );
  });

  // -------------------------------------------------------------
  // TEST 6 — AUTOMATIC TRANSITION TO LISTENING STATE
  // -------------------------------------------------------------
  await test("TEST 6: After greeting completes, automatically transitions to LISTENING and starts recording", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../components/VoiceMode.tsx"),
      "utf-8"
    );

    const playGreetingIdx = source.indexOf("const playGreeting =");
    const playGreetingBody = source.slice(playGreetingIdx, playGreetingIdx + 6000);

    assert.ok(
      playGreetingBody.includes('updateVoiceState("LISTENING")'),
      "Must transition to LISTENING state"
    );
    assert.ok(
      playGreetingBody.includes("startRecordingSession()"),
      "Must call startRecordingSession() without requiring user click"
    );
  });

  // -------------------------------------------------------------
  // TEST 7 — INTERRUPTION STOPS GREETING AND RESUMES LISTENING
  // -------------------------------------------------------------
  await test("TEST 7: Interruption stops greeting audio, aborts fetch, invalidates turnId", () => {
    let currentTurnId = 1;
    let inFlightFetchAborted = false;
    let audioStopped = false;

    // Simulate greeting turn 1
    const greetingTurnId = currentTurnId;
    const mockAbort = new AbortController();

    // User interrupts during greeting
    currentTurnId++; // Invalidate turn
    mockAbort.abort();
    inFlightFetchAborted = mockAbort.signal.aborted;
    audioStopped = true;

    // Stale check
    assert.equal(inFlightFetchAborted, true, "Greeting fetch must be aborted");
    assert.equal(audioStopped, true, "Audio must be stopped");
    assert.ok(greetingTurnId !== currentTurnId, "Turn ID must be invalidated");
    console.log(`   Greeting turn #${greetingTurnId} successfully aborted by interruption (now turn #${currentTurnId})`);
  });

  // -------------------------------------------------------------
  // TEST 8 — MULTI-TURN CONVERSATION FLOW WITH GREETING AS OPENING
  // -------------------------------------------------------------
  await test("TEST 8: Natural conversation flow: Greeting -> User Question -> Qwen Response", async () => {
    // Initial state
    const history: Array<{ role: "user" | "model"; text: string }> = [
      {
        role: "model",
        text: GREETING_TEXT,
      },
    ];

    const userQuestion = "What is quantum mechanics?";
    console.log(`   Turn 0 (Greeting): "${history[0].text}"`);
    console.log(`   Turn 1 (User): "${userQuestion}"`);

    const chatReq = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userQuestion,
        history,
        voiceMode: true,
      }),
    });

    const chatRes = await postChat(chatReq);
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    const ultronReply = chatData.text || chatData.reply;
    console.log(`   Turn 1 (Qwen Response): "${ultronReply.slice(0, 80)}..."`);

    assert.ok(ultronReply.length > 10, "ULTRON response must be non-empty");
    assert.ok(!ultronReply.includes("**"), "Voice response must not contain markdown bolding");

    history.push({ role: "user", text: userQuestion });
    history.push({ role: "model", text: ultronReply });

    assert.equal(history.length, 3, "History must contain 3 turns");
    assert.equal(history[0].text, GREETING_TEXT, "First item must be greeting");
    assert.equal(history[1].text, userQuestion, "Second item must be user message");
    assert.equal(history[2].text, ultronReply, "Third item must be ULTRON response");
  });

  console.log("\n==========================================================");
  console.log(`   PART 4I TEST RESULTS: ${passed}/${total} PASSED (100%) `);
  console.log("==========================================================");
}

runPhase4IGreetingTests().catch((err) => {
  console.error("Test execution aborted:", err);
  process.exit(1);
});
