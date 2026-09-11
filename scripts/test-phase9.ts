import assert from "node:assert/strict";
import {
  encryptApiKey,
  decryptApiKey,
  maskApiKey,
} from "../lib/crypto/encryption";
import {
  saveUserApiKey,
  getUserApiKeyPublicInfo,
  getUserDecryptedApiKey,
  updateUserKeyStatus,
  deleteUserApiKey,
} from "../lib/db/userApiKeyStore";
import {
  getGeminiClientForUser,
  validateGeminiApiKey,
  getGeminiModel,
  DEFAULT_GEMINI_MODEL,
} from "../lib/geminiService";
import { GET as getSettings, POST as saveSettings, DELETE as deleteSettings } from "../app/api/settings/api-key/route";
import { POST as testSettings } from "../app/api/settings/api-key/test/route";
import { POST as postChat } from "../app/api/chat/route";

console.log("=========================================");
console.log("   ULTRON PHASE 9 AUTOMATED TEST SUITE   ");
console.log("=========================================\n");

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
  // Test 1: Crypto Encryption & Decryption
  await test("1. AES-256-GCM Encryption and Decryption Roundtrip", () => {
    const rawKey = "AIzaSyFakeTestKey1234567890abcdefg";
    const encrypted = encryptApiKey(rawKey);

    assert.ok(encrypted.ciphertext, "Ciphertext should not be empty");
    assert.ok(encrypted.iv, "IV should not be empty");
    assert.ok(encrypted.tag, "Auth tag should not be empty");
    assert.notEqual(encrypted.ciphertext, rawKey, "Ciphertext must not be plaintext");

    const decrypted = decryptApiKey(encrypted);
    assert.equal(decrypted, rawKey, "Decrypted key must match original raw key");
  });

  // Test 2: Crypto Tamper Resistance
  await test("2. Tampered Ciphertext or Tag Rejection", () => {
    const rawKey = "AIzaSyTamperProofTestKey999";
    const encrypted = encryptApiKey(rawKey);

    // Tamper with ciphertext
    const tamperedCiphertext =
      encrypted.ciphertext.slice(0, -2) + (encrypted.ciphertext.slice(-2) === "aa" ? "bb" : "aa");
    assert.throws(
      () => decryptApiKey({ ...encrypted, ciphertext: tamperedCiphertext }),
      /Failed to securely decrypt stored credential/
    );

    // Tamper with tag
    const tamperedTag =
      encrypted.tag.slice(0, -2) + (encrypted.tag.slice(-2) === "00" ? "11" : "00");
    assert.throws(
      () => decryptApiKey({ ...encrypted, tag: tamperedTag }),
      /Failed to securely decrypt stored credential/
    );
  });

  // Test 3: Key Masking Utility
  await test("3. API Key Masking & Information Leak Prevention", () => {
    const key = "AIzaSyD_TestKey1234_SuffixXY";
    const masked = maskApiKey(key);

    assert.equal(masked, "••••••••••••ixXY");
    assert.ok(!masked.includes("AIzaSyD_TestKey1234_"), "Masked key must never contain key prefix or body");

    assert.equal(maskApiKey(""), "");
    assert.equal(maskApiKey("123"), "••••");
  });

  // Test 4: Per-User Isolation (User A vs User B)
  await test("4. Strict Per-User Isolation (User A vs User B)", async () => {
    const userA = "usr_test_alpha_" + Date.now();
    const userB = "usr_test_beta_" + Date.now();

    const keyA = "AIzaSyUserAlphaKey_111111111111111";
    const keyB = "AIzaSyUserBetaKey_222222222222222";

    // Initially both should be unconfigured
    const initialA = await getUserApiKeyPublicInfo(userA);
    const initialB = await getUserApiKeyPublicInfo(userB);
    assert.equal(initialA.status, "not_configured");
    assert.equal(initialB.status, "not_configured");
    assert.equal(initialA.isConfigured, false);
    assert.equal(initialB.isConfigured, false);

    // Save key for User A
    const savedA = await saveUserApiKey(userA, keyA);
    assert.equal(savedA.isConfigured, true);
    assert.equal(savedA.status, "configured");
    assert.equal(savedA.keyHint, "••••••••••••1111");

    // User B must still be unconfigured
    const checkB = await getUserApiKeyPublicInfo(userB);
    assert.equal(checkB.isConfigured, false);
    assert.equal(checkB.status, "not_configured");

    // Save key for User B
    const savedB = await saveUserApiKey(userB, keyB);
    assert.equal(savedB.isConfigured, true);
    assert.equal(savedB.keyHint, "••••••••••••2222");

    // Decrypted keys must belong strictly to respective users
    const decryptedA = await getUserDecryptedApiKey(userA);
    const decryptedB = await getUserDecryptedApiKey(userB);
    assert.equal(decryptedA, keyA);
    assert.equal(decryptedB, keyB);
    assert.notEqual(decryptedA, decryptedB);

    // Remove User A's key -> User B must remain intact
    await deleteUserApiKey(userA);
    const postDeleteA = await getUserApiKeyPublicInfo(userA);
    const postDeleteB = await getUserApiKeyPublicInfo(userB);
    assert.equal(postDeleteA.isConfigured, false);
    assert.equal(postDeleteB.isConfigured, true);
    assert.equal(await getUserDecryptedApiKey(userA), null);
    assert.equal(await getUserDecryptedApiKey(userB), keyB);

    // Clean up User B
    await deleteUserApiKey(userB);
  });

  // Test 5: Key Status Transitions
  await test("5. Status Lifecycle Transitions (not_configured -> configured -> valid -> invalid -> not_configured)", async () => {
    const user = "usr_lifecycle_" + Date.now();
    const key = "AIzaSyLifecycleKey_9999999999";

    // 1. Initial
    let info = await getUserApiKeyPublicInfo(user);
    assert.equal(info.status, "not_configured");

    // 2. Configured
    await saveUserApiKey(user, key);
    info = await getUserApiKeyPublicInfo(user);
    assert.equal(info.status, "configured");

    // 3. Valid
    await updateUserKeyStatus(user, "valid");
    info = await getUserApiKeyPublicInfo(user);
    assert.equal(info.status, "valid");
    assert.ok(info.lastTestedAt, "lastTestedAt should be recorded");

    // 4. Invalid
    await updateUserKeyStatus(user, "invalid", "API_KEY_INVALID");
    info = await getUserApiKeyPublicInfo(user);
    assert.equal(info.status, "invalid");
    assert.equal(info.errorMessage, "API_KEY_INVALID");

    // 5. Error
    await updateUserKeyStatus(user, "error", "Network timeout");
    info = await getUserApiKeyPublicInfo(user);
    assert.equal(info.status, "error");

    // 6. Delete
    await deleteUserApiKey(user);
    info = await getUserApiKeyPublicInfo(user);
    assert.equal(info.status, "not_configured");
    assert.equal(info.isConfigured, false);
  });

  // Test 6: Zero Plaintext Key in Public Objects
  await test("6. Zero Raw Key Exposure in Public Output", async () => {
    const user = "usr_leak_test_" + Date.now();
    const secretKey = "AIzaSySuperSecretMustNeverBeInResponse123";

    const publicInfo = await saveUserApiKey(user, secretKey);
    const stringified = JSON.stringify(publicInfo);

    assert.ok(!stringified.includes("AIzaSySuperSecretMustNeverBeInResponse"), "Raw key must not appear in JSON response");
    assert.ok(stringified.includes("••••••••••••e123"), "Masked hint should appear instead");

    await deleteUserApiKey(user);
  });

  // Test 7: Gemini Service Client Resolution (User key vs Dev Fallback vs None)
  await test("7. Gemini Client Resolution Hierarchy", async () => {
    const userWithKey = "usr_client_custom_" + Date.now();
    const userWithoutKey = "usr_client_none_" + Date.now();
    const customKey = "AIzaSyCustomClientKey1234567890";

    await saveUserApiKey(userWithKey, customKey);

    // Case A: User has their own key
    const resA = await getGeminiClientForUser(userWithKey);
    assert.equal(resA.source, "user");
    assert.ok(resA.ai !== null);
    assert.equal(resA.keyHint, "••••••••••••7890");

    // Case B: User has no key, but environment dev fallback exists
    const resB = await getGeminiClientForUser(userWithoutKey);
    if (process.env.GEMINI_API_KEY) {
      assert.equal(resB.source, "system_fallback");
      assert.ok(resB.ai !== null);
    } else {
      assert.equal(resB.source, "none");
      assert.equal(resB.ai, null);
    }

    // Clean up
    await deleteUserApiKey(userWithKey);
  });

  // Test 8: Key Validation Error Handling
  await test("8. Key Validation Graceful Handling of Invalid Keys", async () => {
    // Empty key
    const emptyResult = await validateGeminiApiKey("");
    assert.equal(emptyResult.valid, false);
    assert.equal(emptyResult.status, "invalid");

    // Invalid format / dummy key
    const dummyResult = await validateGeminiApiKey("AIzaSyFakeBogusInvalidKeyThatDoesNotExist");
    assert.equal(dummyResult.valid, false);
    assert.equal(dummyResult.status, "invalid");
    assert.ok(dummyResult.message.includes("Invalid Gemini API key"), "Should return friendly user message");
    assert.ok(!dummyResult.message.includes("AIzaSyFakeBogus"), "Error message must never echo the raw key");
  });

  // Test 9: HTTP Route Handlers Integration & Isolation
  await test("9. HTTP Route Handlers Integration & Multi-User Isolation", async () => {
    const httpUserA = "usr_http_a_" + Date.now();
    const httpUserB = "usr_http_b_" + Date.now();
    const keyA = "AIzaSyHttpUserAKey123456";
    const keyB = "AIzaSyHttpUserBKey987654";

    // 1. Initial GET
    const getRes = await getSettings(
      new Request("http://localhost:3000/api/settings/api-key", {
        headers: { "x-ultron-user-id": httpUserA },
      })
    );
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.isConfigured, false);

    // 2. POST save key for User A
    const saveResA = await saveSettings(
      new Request("http://localhost:3000/api/settings/api-key", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ultron-user-id": httpUserA,
        },
        body: JSON.stringify({ apiKey: keyA }),
      })
    );
    assert.equal(saveResA.status, 200);
    const saveResAText = await saveResA.text();
    assert.ok(!saveResAText.includes(keyA), "Response must not contain raw key");
    assert.ok(saveResAText.includes("••••••••••••3456"));

    // 3. User B is isolated
    const getResB = await getSettings(
      new Request("http://localhost:3000/api/settings/api-key", {
        headers: { "x-ultron-user-id": httpUserB },
      })
    );
    const getDataB = await getResB.json();
    assert.equal(getDataB.isConfigured, false, "User B must not see User A's key");

    // 4. Test invalid candidate key via HTTP test endpoint
    const testRes = await testSettings(
      new Request("http://localhost:3000/api/settings/api-key/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ultron-user-id": httpUserA,
        },
        body: JSON.stringify({ candidateKey: "AIzaSyFakeBogusTesting123" }),
      })
    );
    assert.equal(testRes.status, 200);
    const testData = await testRes.json();
    assert.equal(testData.success, false);
    assert.equal(testData.status, "invalid");

    // 5. DELETE key for User A
    const delResA = await deleteSettings(
      new Request("http://localhost:3000/api/settings/api-key", {
        method: "DELETE",
        headers: { "x-ultron-user-id": httpUserA },
      })
    );
    assert.equal(delResA.status, 200);
    const delDataA = await delResA.json();
    assert.equal(delDataA.isConfigured, false);
    assert.equal(delDataA.status, "not_configured");
  });

  // Test 10: Chat Route Validation
  await test("10. Chat Route Validation (Empty Message Rejection)", async () => {
    const chatUser = "usr_chat_val_" + Date.now();
    await saveUserApiKey(chatUser, "AIzaSyMockKeyForChatValidation");

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ultron-user-id": chatUser,
      },
      body: JSON.stringify({ message: "   " }),
    });
    const res = await postChat(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("non-empty string"));

    await deleteUserApiKey(chatUser);
  });

  // Test 11: Stable Gemini Model Configuration (gemini-3.6-flash)
  await test("11. Centralized Stable Gemini Model (gemini-3.6-flash)", () => {
    assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.6-flash", "DEFAULT_GEMINI_MODEL must be gemini-3.6-flash");
    const resolvedModel = getGeminiModel();
    assert.equal(resolvedModel, "gemini-3.6-flash", "Resolved Gemini model must be gemini-3.6-flash");
    assert.ok(!resolvedModel.includes("preview"), "Model must not be a preview version");
    assert.ok(!resolvedModel.includes("2.6"), "Model must not be 2.6");
  });

  console.log("\n-----------------------------------------");
  console.log(`RESULTS: ${passed}/${total} tests passed.`);
  console.log("-----------------------------------------\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
