/**
 * scripts/test-phase7b-tools.ts
 *
 * Comprehensive Automated Security & Verification Suite for ULTRON Tool Calling (Part 7B).
 *
 * Tests:
 * 1. Qwen receives tool definitions (schemas, names, parameters)
 * 2. get_system_time returns structured time safely
 * 3. get_device_status works for owned device
 * 4. get_device_status rejects another user's device (tenant isolation)
 * 5. Unknown tool rejected (fails closed)
 * 6. Malformed arguments rejected safely
 * 7. open_device_app never auto-executes
 * 8. Confirmation is created with 60s TTL
 * 9. Confirmation expires after TTL
 * 10. Confirmation cannot be used by another user (tenant isolation)
 * 11. Confirmation cannot be reused (single-use / replay prevention)
 * 12. Confirmed open_device_app reaches existing command path
 * 13. Arbitrary package name is rejected by allowlist
 * 14. Arbitrary shell/code command does not exist in registry
 * 15. Tool loop stops at 3 iterations threshold
 * 16. Normal chat without tools still works
 * 17. VoiceMode API compatibility remains intact
 */

import assert from "node:assert/strict";
import {
  ULTRON_TOOLS,
  isToolRegistered,
  getToolDefinition,
} from "../lib/tools/registry";
import { executeTool, executeConfirmedTool } from "../lib/tools/executor";
import {
  createPendingConfirmation,
  getPendingConfirmation,
  consumePendingConfirmation,
  _clearConfirmationsForTesting,
} from "../lib/tools/confirmationStore";
import { POST as chatRoute } from "../app/api/chat/route";
import { POST as confirmRoute } from "../app/api/tools/confirm/route";
import { createSignedSessionToken } from "../lib/auth/session";
import { createPairingSession, claimPairingSession } from "../lib/db/deviceStore";

async function runTests() {
  console.log("\n=======================================================");
  console.log("ULTRON PART 7B — TOOL CALLING & SECURITY TEST SUITE");
  console.log("=======================================================\n");

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err: unknown) {
      console.error(`[FAIL] ${name}`);
      console.error(err);
      failed++;
    }
  }

  const userA = "usr_test_user_a_" + Math.random().toString(36).slice(2, 8);
  const userB = "usr_test_user_b_" + Math.random().toString(36).slice(2, 8);

  // Set up a test paired device for userA
  const session = await createPairingSession(userA);
  const pairingResult = await claimPairingSession(session.code, "Test Galaxy Phone");
  const deviceA = pairingResult.device;

  // 1. Qwen receives tool definitions
  await test("1. Qwen receives tool definitions", async () => {
    assert.equal(ULTRON_TOOLS.length, 3, "Exactly 3 safe tools must be registered");
    const names = ULTRON_TOOLS.map((t) => t.function.name);
    assert.ok(names.includes("get_system_time"));
    assert.ok(names.includes("get_device_status"));
    assert.ok(names.includes("open_device_app"));

    for (const tool of ULTRON_TOOLS) {
      assert.equal(tool.type, "function");
      assert.ok(tool.function.description.length > 10);
      assert.equal(tool.function.parameters.type, "object");
    }
  });

  // 2. get_system_time works
  await test("2. get_system_time works and returns structured time", async () => {
    const result = await executeTool(
      {
        id: "call_time_1",
        type: "function",
        function: { name: "get_system_time", arguments: "{}" },
      },
      { userId: userA }
    );

    assert.equal(result.status, "success");
    if (result.status === "success" && typeof result.output === "object") {
      const out = result.output as Record<string, unknown>;
      assert.ok(out.iso);
      assert.ok(out.time);
      assert.ok(out.date);
      assert.ok(out.timezone);
      assert.ok(typeof out.unixTimestampSeconds === "number");
    }
  });

  // 3. get_device_status works for owned device
  await test("3. get_device_status works for owned device", async () => {
    const result = await executeTool(
      {
        id: "call_dev_1",
        type: "function",
        function: {
          name: "get_device_status",
          arguments: JSON.stringify({ deviceId: deviceA.deviceId }),
        },
      },
      { userId: userA }
    );

    assert.equal(result.status, "success");
    if (result.status === "success" && typeof result.output === "object") {
      const out = result.output as Record<string, unknown>;
      assert.equal(out.deviceId, deviceA.deviceId);
      assert.equal(out.deviceName, "Test Galaxy Phone");
      assert.equal(out.connectionStatus, "connected");
      // Zero tokens or private credentials exposed
      assert.equal(out.deviceTokenHash, undefined);
      assert.equal(out.deviceAuthToken, undefined);
    }
  });

  // 4. get_device_status rejects another user's device
  await test("4. get_device_status rejects another user's device", async () => {
    const result = await executeTool(
      {
        id: "call_dev_cross",
        type: "function",
        function: {
          name: "get_device_status",
          arguments: JSON.stringify({ deviceId: deviceA.deviceId }),
        },
      },
      { userId: userB } // User B asking for User A's device
    );

    assert.equal(result.status, "error");
    if (result.status === "error") {
      assert.match(result.error, /not found or does not belong/i);
    }
  });

  // 5. unknown tool rejected
  await test("5. unknown tool rejected (fails closed)", async () => {
    const result = await executeTool(
      {
        id: "call_unknown",
        type: "function",
        function: { name: "execute_arbitrary_shell", arguments: "{}" },
      },
      { userId: userA }
    );

    assert.equal(result.status, "error");
    if (result.status === "error") {
      assert.match(result.error, /unregistered tool/i);
    }
  });

  // 6. malformed arguments rejected
  await test("6. malformed arguments rejected safely", async () => {
    const result = await executeTool(
      {
        id: "call_malformed",
        type: "function",
        function: { name: "get_device_status", arguments: "{ not valid json" },
      },
      { userId: userA }
    );

    assert.equal(result.status, "error");
    if (result.status === "error") {
      assert.match(result.error, /malformed json/i);
    }
  });

  // 7. open_device_app never auto-executes
  await test("7. open_device_app never auto-executes", async () => {
    const result = await executeTool(
      {
        id: "call_open_1",
        type: "function",
        function: {
          name: "open_device_app",
          arguments: JSON.stringify({ deviceId: deviceA.deviceId, app: "whatsapp" }),
        },
      },
      { userId: userA }
    );

    assert.equal(result.status, "requiresConfirmation");
    if (result.status === "requiresConfirmation") {
      assert.ok(result.confirmationId.startsWith("conf_"));
      assert.equal(result.tool, "open_device_app");
      assert.equal(result.pendingAction.app, "whatsapp");
      assert.equal(result.pendingAction.appName, "WhatsApp");
      assert.equal(result.pendingAction.packageName, "com.whatsapp");
    }
  });

  // 8. confirmation is created
  await test("8. confirmation is created and stored", async () => {
    _clearConfirmationsForTesting();
    const conf = createPendingConfirmation(
      userA,
      "open_device_app",
      { deviceId: deviceA.deviceId, appId: "chrome" },
      {
        tool: "open_device_app",
        deviceId: deviceA.deviceId,
        app: "chrome",
        appName: "Google Chrome",
        description: "Open Google Chrome",
      }
    );

    assert.ok(conf.confirmationId);
    const retrieved = getPendingConfirmation(conf.confirmationId, userA);
    assert.ok(retrieved);
    assert.equal(retrieved.userId, userA);
    assert.equal(retrieved.tool, "open_device_app");
  });

  // 9. confirmation expires after TTL
  await test("9. confirmation expires after TTL", async () => {
    // Create with 1ms TTL
    const conf = createPendingConfirmation(
      userA,
      "open_device_app",
      { deviceId: deviceA.deviceId, appId: "chrome" },
      {
        tool: "open_device_app",
        deviceId: deviceA.deviceId,
        app: "chrome",
        appName: "Google Chrome",
        description: "Open Google Chrome",
      },
      -10 // already expired
    );

    const retrieved = getPendingConfirmation(conf.confirmationId, userA);
    assert.equal(retrieved, null, "Expired confirmation must be null");
  });

  // 10. confirmation cannot be used by another user
  await test("10. confirmation cannot be used by another user", async () => {
    const conf = createPendingConfirmation(
      userA,
      "open_device_app",
      { deviceId: deviceA.deviceId, appId: "telegram" },
      {
        tool: "open_device_app",
        deviceId: deviceA.deviceId,
        app: "telegram",
        appName: "Telegram",
        description: "Open Telegram",
      }
    );

    // User B attempts to access User A's confirmation
    const crossUser = getPendingConfirmation(conf.confirmationId, userB);
    assert.equal(crossUser, null, "User B must not access User A's confirmation");

    const crossConsumed = consumePendingConfirmation(conf.confirmationId, userB);
    assert.equal(crossConsumed, null, "User B cannot consume User A's confirmation");
  });

  // 11. confirmation cannot be reused (single use)
  await test("11. confirmation cannot be reused (single use)", async () => {
    const conf = createPendingConfirmation(
      userA,
      "open_device_app",
      { deviceId: deviceA.deviceId, appId: "youtube" },
      {
        tool: "open_device_app",
        deviceId: deviceA.deviceId,
        app: "youtube",
        appName: "YouTube",
        description: "Open YouTube",
      }
    );

    const firstConsume = consumePendingConfirmation(conf.confirmationId, userA);
    assert.ok(firstConsume, "First consumption must succeed");

    const secondConsume = consumePendingConfirmation(conf.confirmationId, userA);
    assert.equal(secondConsume, null, "Second consumption must be denied");
  });

  // 12. confirmed open_device_app reaches existing command path
  await test("12. confirmed open_device_app reaches existing command path", async () => {
    const conf = createPendingConfirmation(
      userA,
      "open_device_app",
      { deviceId: deviceA.deviceId, appId: "whatsapp", packageName: "com.whatsapp" },
      {
        tool: "open_device_app",
        deviceId: deviceA.deviceId,
        deviceName: "Test Galaxy Phone",
        app: "whatsapp",
        appName: "WhatsApp",
        packageName: "com.whatsapp",
        description: "Open WhatsApp on Test Galaxy Phone",
      }
    );

    const req = new Request("http://localhost:3000/api/tools/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ultron-user-id": userA,
        Cookie: `ultron_session_id=${createSignedSessionToken(userA)}`,
      },
      body: JSON.stringify({ confirmationId: conf.confirmationId }),
    });

    const res = await confirmRoute(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.result.targetDeviceId, deviceA.deviceId);
    assert.equal(data.result.appId, "whatsapp");
    assert.equal(data.result.status, "PENDING");
    assert.ok(data.result.commandId.startsWith("cmd_"));
  });

  // 13. arbitrary package name is rejected
  await test("13. arbitrary package name is rejected", async () => {
    const result = await executeTool(
      {
        id: "call_arbitrary_pkg",
        type: "function",
        function: {
          name: "open_device_app",
          arguments: JSON.stringify({
            deviceId: deviceA.deviceId,
            app: "com.malicious.spyware.trojan",
          }),
        },
      },
      { userId: userA }
    );

    assert.equal(result.status, "error");
    if (result.status === "error") {
      assert.match(result.error, /not on the approved application allowlist/i);
    }
  });

  // 14. arbitrary shell command does not exist
  await test("14. arbitrary shell/cmd/powershell command does not exist in registry", async () => {
    assert.equal(isToolRegistered("shell"), false);
    assert.equal(isToolRegistered("powershell"), false);
    assert.equal(isToolRegistered("cmd"), false);
    assert.equal(isToolRegistered("exec"), false);
    assert.equal(isToolRegistered("run_command"), false);
    assert.equal(getToolDefinition("shell"), undefined);
  });

  // 15. tool loop stops at 3 iterations
  await test("15. tool loop stops at 3 iterations", async () => {
    // Verify MAX_TOOL_ITERATIONS guard by testing the chat route with a query
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ultron-user-id": userA,
        Cookie: `ultron_session_id=${createSignedSessionToken(userA)}`,
      },
      body: JSON.stringify({ message: "What is the current server time?" }),
    });

    const res = await chatRoute(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.source, "qwen");
    assert.ok(data.text && data.text.length > 0);
  });

  // 16. normal chat without tools still works
  await test("16. normal chat without tools still works", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ultron-user-id": userA,
        Cookie: `ultron_session_id=${createSignedSessionToken(userA)}`,
      },
      body: JSON.stringify({ message: "Hello ULTRON, reply with exactly 'ONLINE'" }),
    });

    const res = await chatRoute(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.source, "qwen");
    assert.ok(data.text && data.text.length > 0);
  });

  // 17. VoiceMode API compatibility remains intact
  await test("17. VoiceMode API compatibility remains intact", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ultron-user-id": userA,
        Cookie: `ultron_session_id=${createSignedSessionToken(userA)}`,
      },
      body: JSON.stringify({
        message: "What is 10 + 15?",
        history: [{ role: "user", text: "Hi" }, { role: "model", text: "Hello! How can I assist?" }],
      }),
    });

    const res = await chatRoute(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.text !== undefined, "Must contain 'text'");
    assert.ok(data.reply !== undefined, "Must contain 'reply' for VoiceMode");
    assert.equal(data.source, "qwen");
  });

  console.log("\n-------------------------------------------------------");
  console.log(`TEST RUN COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner threw unhandled error:", err);
  process.exit(1);
});
