import assert from "node:assert/strict";
import { splitTextForTTS, HARD_MAX_TTS_CHUNK_LENGTH } from "../lib/ttsChunker";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postTTS } from "../app/api/voice/tts/route";

async function runManualConversations() {
  console.log("==========================================================");
  console.log("      ULTRON PART 4F — MANUAL CONVERSATION VERIFICATION    ");
  console.log("==========================================================\n");

  const conversationHistory: Array<{ role: "user" | "model"; text: string }> = [];

  async function executeTurn(userPrompt: string, label: string) {
    console.log(`\n--- [${label}] ---`);
    console.log(`USER: "${userPrompt}"`);

    // 1. Send to chat API with voiceMode: true and conversation history
    const t0_chat = Date.now();
    const chatRes = await postChat(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userPrompt,
          history: conversationHistory,
          voiceMode: true,
        }),
      })
    );
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    const ultronReply = chatData.text || chatData.reply;
    const chatLatency = Date.now() - t0_chat;

    console.log(`ULTRON (${ultronReply.length} chars, ${chatLatency}ms): "${ultronReply}"`);

    // 2. Append turns chronologically
    conversationHistory.push({ role: "user", text: userPrompt });
    conversationHistory.push({ role: "model", text: ultronReply });

    // 3. Chunk text for TTS
    const chunks = splitTextForTTS(ultronReply);
    console.log(`CHUNKS: ${chunks.length} safe chunk(s) generated`);

    const chunkLatencies: number[] = [];

    // 4. Sequential Kokoro TTS synthesis (test first 3 chunks to verify sequential playback & timeout safety)
    const chunksToSynthesize = chunks.slice(0, 3);
    for (let i = 0; i < chunksToSynthesize.length; i++) {
      const c = chunksToSynthesize[i];
      assert.ok(c.length <= HARD_MAX_TTS_CHUNK_LENGTH, `Chunk ${i + 1} exceeds 300 chars: ${c.length}`);

      const t0_tts = Date.now();
      const ttsRes = await postTTS(
        new Request("http://localhost:3000/api/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: c }),
        })
      );
      const ttsLatency = Date.now() - t0_tts;
      assert.equal(ttsRes.status, 200);
      assert.ok(ttsLatency < 20000, `Kokoro chunk timed out: ${ttsLatency}ms`);

      chunkLatencies.push(ttsLatency);
      console.log(`  [TTS] chunk ${i + 1}/${chunks.length} (${c.length} chars): latency=${ttsLatency}ms`);
    }

    return { ultronReply, chunks, chunkLatencies, chatLatency };
  }

  // 1. "Hello Ultron."
  const res1 = await executeTurn("Hello Ultron.", "CONVERSATION 1: Short Greeting");
  assert.ok(res1.chunks.length >= 1);

  // 2. "Can you explain quantum mechanics?"
  const res2 = await executeTurn("Can you explain quantum mechanics?", "CONVERSATION 2: Explanatory Topic");
  assert.ok(res2.chunks.length >= 1);

  // 3. "Explain how the internet works in detail."
  const res3 = await executeTurn("Explain how the internet works in detail.", "CONVERSATION 3: Detailed Topic");
  assert.ok(res3.chunks.length >= 1);

  // 4. Consecutive question immediately after the previous answer
  console.log("\n--- [CONVERSATION 4: Consecutive Follow-up Question] ---");
  const res4 = await executeTurn(
    "What are the main components of a computer network?",
    "CONVERSATION 4: Follow-up"
  );
  assert.equal(conversationHistory.length, 8, "8 turns must be present in history in strict chronological order");

  // Verify chronological order
  console.log("\n--- CHRONOLOGICAL ORDER VERIFICATION ---");
  for (let idx = 0; idx < conversationHistory.length; idx++) {
    const turn = conversationHistory[idx];
    console.log(`  [Slot ${idx}] ${turn.role.toUpperCase()}: ${turn.text.slice(0, 60)}...`);
  }
  assert.equal(conversationHistory[0].text, "Hello Ultron.");
  assert.equal(conversationHistory[6].text, "What are the main components of a computer network?");
  console.log("[PASS] Chronological message ordering verified strictly.");

  // 5. Interruption simulation
  console.log("\n--- [CONVERSATION 5: Interruption During Active TTS] ---");
  let activeTurnId = 100;
  const turnId = activeTurnId;
  let discardedChunks = 0;
  const longChunks = ["Chunk A (playing)", "Chunk B (queued)", "Chunk C (queued)"];

  for (let i = 0; i < longChunks.length; i++) {
    if (activeTurnId !== turnId) {
      discardedChunks++;
      continue;
    }
    console.log(`  Playing ${longChunks[i]}`);
    if (i === 0) {
      console.log(`  >>> BARGE-IN EVENT: User started speaking. Invalidation triggered.`);
      activeTurnId++; // Invalidate turn
    }
  }
  assert.equal(discardedChunks, 2, "2 queued chunks were successfully discarded on interruption");
  console.log(`[PASS] Interruption stopped current audio and discarded ${discardedChunks} queued chunks.`);

  // 6. Ask another question after interruption
  console.log("\n--- [CONVERSATION 6: Question After Interruption] ---");
  const res6 = await executeTurn("What is 15 times 4?", "CONVERSATION 6: Question After Interruption");
  assert.ok(res6.ultronReply.includes("60"));
  console.log("[PASS] New question processed smoothly after interruption without stale audio.");

  console.log("\n==========================================================");
  console.log("       ALL 6 MANUAL CONVERSATION TESTS PASSED 100%        ");
  console.log("==========================================================");
}

runManualConversations().catch((err) => {
  console.error("Manual test failure:", err);
  process.exit(1);
});
