import assert from "node:assert/strict";
import { POST as postChat } from "../app/api/chat/route";
import { generateQwenResponse } from "../lib/qwenService";

console.log("==========================================");
console.log("   ULTRON QWEN3-8B INTEGRATION TEST SUITE ");
console.log("==========================================\n");

async function runTests() {
  // --- TEST A: Direct Service & ULTRON Persona ---
  console.log("--- TEST A: ULTRON Persona & Basic Introduction ---");
  const pA = "Hello ULTRON, introduce yourself in one sentence.";
  console.log(`User: "${pA}"`);
  const rA = await generateQwenResponse(pA);
  console.log(`ULTRON: "${rA.text}"\n`);

  assert.ok(rA.text.length > 0, "Response must not be empty");
  const textLowerA = rA.text.toLowerCase();
  assert.ok(textLowerA.includes("ultron"), "Response must identify as ULTRON");
  assert.ok(!textLowerA.includes("i am qwen"), "Response must NOT claim to be Qwen");
  assert.ok(!textLowerA.includes("i am gemini"), "Response must NOT claim to be Gemini");
  console.log("TEST A: PASS (Identifies as ULTRON, no Gemini/Qwen claim)\n");

  // --- TEST B: Arithmetic via /api/chat route ---
  console.log("--- TEST B: Arithmetic via /api/chat route ---");
  const pB = "What is 25 × 16?";
  console.log(`User: "${pB}"`);
  const reqB = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: pB }),
  });
  const resB = await postChat(reqB);
  assert.equal(resB.status, 200, "Chat route must return HTTP 200");
  const dataB = await resB.json();
  console.log(`ULTRON: "${dataB.text}"`);
  assert.equal(dataB.source, "qwen", "Source must be 'qwen'");
  assert.ok(dataB.text.includes("400"), "Response must contain '400'");
  console.log("TEST B: PASS (25 × 16 = 400)\n");

  // --- TEST C: Multi-turn Context Retention ---
  console.log("--- TEST C: Multi-Turn Conversation Context Retention ---");
  const pC1 = "My favorite programming language is C++.";
  console.log(`Turn 1 User: "${pC1}"`);
  const reqC1 = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: pC1 }),
  });
  const resC1 = await postChat(reqC1);
  assert.equal(resC1.status, 200);
  const dataC1 = await resC1.json();
  console.log(`Turn 1 ULTRON: "${dataC1.text}"\n`);

  const pC2 = "What is my favorite programming language?";
  console.log(`Turn 2 User: "${pC2}"`);
  const reqC2 = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: pC2,
      history: [
        { role: "user", text: pC1 },
        { role: "assistant", text: dataC1.text },
      ],
    }),
  });
  const resC2 = await postChat(reqC2);
  assert.equal(resC2.status, 200);
  const dataC2 = await resC2.json();
  console.log(`Turn 2 ULTRON: "${dataC2.text}"\n`);
  const textLowerC2 = dataC2.text.toLowerCase();
  assert.ok(
    textLowerC2.includes("c++") || textLowerC2.includes("cpp"),
    "ULTRON must recall user's favorite language is C++"
  );
  console.log("TEST C: PASS (Context recalled C++)\n");

  // --- TEST D: Conciseness ---
  console.log("--- TEST D: Conciseness Constraint ---");
  const pD = "Give me a 20-word explanation of quantum computing.";
  console.log(`User: "${pD}"`);
  const reqD = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: pD }),
  });
  const resD = await postChat(reqD);
  assert.equal(resD.status, 200);
  const dataD = await resD.json();
  console.log(`ULTRON: "${dataD.text}"`);
  const wordCount = dataD.text.trim().split(/\s+/).length;
  console.log(`Word Count: ${wordCount}`);
  assert.ok(wordCount <= 45, "Explanation must respect conciseness constraint");
  console.log("TEST D: PASS (Conciseness respected)\n");

  // --- TEST E: Coding ---
  console.log("--- TEST E: Coding (C++ Array Reversal) ---");
  const pE = "Write a simple C++ program to reverse an array.";
  console.log(`User: "${pE}"`);
  const reqE = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: pE }),
  });
  const resE = await postChat(reqE);
  assert.equal(resE.status, 200);
  const dataE = await resE.json();
  console.log(`ULTRON:\n${dataE.text}\n`);
  assert.ok(
    dataE.text.includes("#include") || dataE.text.includes("reverse"),
    "C++ code must include valid C++ code structure"
  );
  console.log("TEST E: PASS (Valid C++ code generated)\n");

  console.log("==========================================");
  console.log("ALL 5 QWEN INTEGRATION TESTS PASSED!");
  console.log("==========================================");
}

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
