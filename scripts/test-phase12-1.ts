import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  createPairingSession,
  claimPairingSession,
  _clearPairingSessionsForTest,
} from "../lib/db/deviceStore";
import { POST as commandsRoute } from "../app/api/devices/[deviceId]/commands/route";
import type { DeviceCommand, DeviceCommandResult } from "../lib/realtime/deviceRealtime";

console.log("=================================================");
console.log("   ULTRON PHASE 12 STEP 1: SECURE TRANSPORT     ");
console.log("=================================================\n");

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

/**
 * Android Companion Simulator implementing exact UltronRealtimeManager logic:
 * - Target device isolation
 * - Expiry checks
 * - Bounded LRU replay cache (max 500)
 * - Allowlisted PING command execution
 */
class SimulatedAndroidCompanion {
  deviceId: string;
  deviceName: string;
  replayCache = new Set<string>();
  receivedCommands: DeviceCommand[] = [];
  results: DeviceCommandResult[] = [];

  constructor(deviceId: string, deviceName: string) {
    this.deviceId = deviceId;
    this.deviceName = deviceName;
  }

  handleBroadcastMessage(bPayload: any): DeviceCommandResult | null {
    const cmdId = String(bPayload?.commandId || "").trim();
    const targetDeviceId = String(bPayload?.targetDeviceId || "").trim();
    const commandType = String(bPayload?.commandType || "").trim();
    const expiresAt = Number(bPayload?.expiresAt || 0);

    // 1. Target device isolation: compare targetDeviceId with local deviceId
    // If they do not match, silently ignore the command.
    if (!targetDeviceId || targetDeviceId !== this.deviceId) {
      return null;
    }

    if (!cmdId) {
      return null;
    }

    this.receivedCommands.push(bPayload);

    // 2. Expiry check: compare server expiresAt with current time
    const currentTime = Date.now();
    if (expiresAt > 0 && currentTime > expiresAt) {
      const res: DeviceCommandResult = {
        commandId: cmdId,
        deviceId: this.deviceId,
        status: "EXPIRED",
        error: "Command expired before processing.",
        completedAt: new Date().toISOString(),
      };
      this.results.push(res);
      return res;
    }

    // 3. Replay protection check
    if (this.replayCache.has(cmdId)) {
      const res: DeviceCommandResult = {
        commandId: cmdId,
        deviceId: this.deviceId,
        status: "DUPLICATE",
        error: "Command has already been processed.",
        completedAt: new Date().toISOString(),
      };
      this.results.push(res);
      return res;
    }

    // 4. Command allowlist check (PING only)
    if (commandType !== "PING") {
      const res: DeviceCommandResult = {
        commandId: cmdId,
        deviceId: this.deviceId,
        status: "FAILED",
        error: `Unsupported commandType: '${commandType}'. Only PING is supported in Phase 12 Step 1.`,
        completedAt: new Date().toISOString(),
      };
      this.results.push(res);
      return res;
    }

    // 5. Execute PING -> PONG & cache commandId
    this.replayCache.add(cmdId);
    if (this.replayCache.size > 500) {
      const oldest = this.replayCache.values().next().value;
      if (oldest) this.replayCache.delete(oldest);
    }

    const res: DeviceCommandResult = {
      commandId: cmdId,
      deviceId: this.deviceId,
      status: "SUCCESS",
      result: { type: "PONG" },
      completedAt: new Date().toISOString(),
    };
    this.results.push(res);
    return res;
  }
}

async function runAllTests() {
  _clearPairingSessionsForTest();

  const testUserId = "usr_phase12_test_owner";
  const otherUserId = "usr_phase12_other_user";

  // Setup 3 paired devices for the test user
  const sessionA = await createPairingSession(testUserId);
  const pairedA = await claimPairingSession(sessionA.code, "Motorola Edge 60 Pro", "Android", "1.0.0");
  assert.ok(pairedA);

  const sessionB = await createPairingSession(testUserId);
  const pairedB = await claimPairingSession(sessionB.code, "Samsung Galaxy S24", "Android", "1.0.0");
  assert.ok(pairedB);

  const sessionC = await createPairingSession(testUserId);
  const pairedC = await claimPairingSession(sessionC.code, "Google Pixel 9", "Android", "1.0.0");
  assert.ok(pairedC);

  // Setup 1 paired device for another user (for cross-user rejection tests)
  const sessionOther = await createPairingSession(otherUserId);
  const pairedOther = await claimPairingSession(sessionOther.code, "Alien Device", "Android", "1.0.0");
  assert.ok(pairedOther);

  const devA = new SimulatedAndroidCompanion(pairedA.device.deviceId, pairedA.device.deviceName);
  const devB = new SimulatedAndroidCompanion(pairedB.device.deviceId, pairedB.device.deviceName);
  const devC = new SimulatedAndroidCompanion(pairedC.device.deviceId, pairedC.device.deviceName);

  // Helper to create mock authenticated HTTP Request
  const createMockCommandRequest = (
    targetDeviceId: string,
    body: any,
    userId: string | null = testUserId
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (userId) {
      headers["x-ultron-user-id"] = userId;
    }

    return {
      req: new Request(`http://localhost:3000/api/devices/${targetDeviceId}/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      params: Promise.resolve({ deviceId: targetDeviceId }),
    };
  };

  // Test 1: Web API Authentication Enforcement (401 when unauthenticated)
  await test("1. Web API Rejection on Unauthenticated Command Dispatch (401)", async () => {
    const { req, params } = createMockCommandRequest(
      devA.deviceId,
      { commandType: "PING", payload: {} },
      null // No session / no user id
    );
    const res = await commandsRoute(req, { params });
    assert.equal(res.status, 401, "Must return 401 when no session cookie or header");
    const json = await res.json();
    assert.ok(json.error.includes("Unauthorized"), "Error message must indicate unauthorized");
  });

  // Test 2: Web API Device Ownership Validation (404 for device belonging to another user)
  await test("2. Web API Rejection for Unowned / Cross-User Device (404)", async () => {
    // testUser trying to dispatch to pairedOther's device
    const { req, params } = createMockCommandRequest(
      pairedOther.device.deviceId,
      { commandType: "PING", payload: {} },
      testUserId
    );
    const res = await commandsRoute(req, { params });
    assert.equal(res.status, 404, "Must return 404 for device not owned by authenticated user");
    const json = await res.json();
    assert.ok(json.error.includes("not found") || json.error.includes("not registered"));
  });

  // Test 3: Web API Allowlist Validation (400 for unapproved command types)
  await test("3. Web API Rejection for Disallowed Command Types (400)", async () => {
    const disallowedTypes = ["CALL_PHONE", "SEND_SMS", "LAUNCH_APP", "SHELL_EXEC", "CAPTURE_MIC"];
    for (const cmdType of disallowedTypes) {
      const { req, params } = createMockCommandRequest(
        devA.deviceId,
        { commandType: cmdType, payload: {} },
        testUserId
      );
      const res = await commandsRoute(req, { params });
      assert.equal(res.status, 400, `Must reject '${cmdType}' with 400 Bad Request`);
      const json = await res.json();
      assert.ok(json.error.includes("Unsupported commandType"));
    }
  });

  // Test 4: Web API Successful Dispatch of Allowlisted PING
  let dispatchedCommandId = "";
  await test("4. Web API Successful Dispatch of Allowlisted PING (200 OK)", async () => {
    const { req, params } = createMockCommandRequest(
      devB.deviceId,
      { commandType: "PING", payload: {} },
      testUserId
    );
    const res = await commandsRoute(req, { params });
    assert.equal(res.status, 200, "Must return 200 OK for valid PING");
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.commandId.startsWith("cmd_"), "CommandId must start with cmd_");
    assert.equal(json.status, "PENDING");
    assert.equal(json.targetDeviceId, devB.deviceId);
    assert.ok(typeof json.expiresAt === "number", "expiresAt must be numeric timestamp");
    assert.ok(json.expiresAt > Date.now() + 40_000, "expiresAt must be ~45s in future");

    dispatchedCommandId = json.commandId;
  });

  // Test 5: Target Device Isolation (Target Device B executes, Devices A & C ignore)
  await test("5. Target Device Isolation (Target Device B Executes, Devices A & C Silently Ignore)", async () => {
    const commandPayload: DeviceCommand = {
      commandId: dispatchedCommandId,
      targetDeviceId: devB.deviceId,
      commandType: "PING",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 45_000,
      payload: {},
      source: "ultron-web",
    };

    // Broadcast is delivered to all 3 devices on the user's channel:
    const resultA = devA.handleBroadcastMessage(commandPayload);
    const resultB = devB.handleBroadcastMessage(commandPayload);
    const resultC = devC.handleBroadcastMessage(commandPayload);

    // Device A and Device C MUST silently ignore:
    assert.equal(resultA, null, "Device A must return null (silently ignore)");
    assert.equal(resultC, null, "Device C must return null (silently ignore)");
    assert.equal(devA.receivedCommands.length, 0, "Device A must not store un-targeted commands");
    assert.equal(devC.receivedCommands.length, 0, "Device C must not store un-targeted commands");

    // Device B MUST process and reply with SUCCESS / PONG:
    assert.ok(resultB, "Device B must process command");
    assert.equal(resultB.commandId, dispatchedCommandId);
    assert.equal(resultB.deviceId, devB.deviceId);
    assert.equal(resultB.status, "SUCCESS");
    assert.deepEqual(resultB.result, { type: "PONG" });
    assert.ok(resultB.completedAt);
  });

  // Test 6: Target Device A Execution Isolation (Target Device A Executes, Devices B & C Ignore)
  await test("6. Target Device Isolation (Target Device A Executes, Devices B & C Silently Ignore)", async () => {
    const cmdIdA = `cmd_${crypto.randomBytes(12).toString("hex")}`;
    const commandPayload: DeviceCommand = {
      commandId: cmdIdA,
      targetDeviceId: devA.deviceId,
      commandType: "PING",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 45_000,
      payload: {},
      source: "ultron-web",
    };

    const resultA = devA.handleBroadcastMessage(commandPayload);
    const resultB = devB.handleBroadcastMessage(commandPayload);
    const resultC = devC.handleBroadcastMessage(commandPayload);

    assert.equal(resultB, null, "Device B must silently ignore command intended for Device A");
    assert.equal(resultC, null, "Device C must silently ignore command intended for Device A");

    assert.ok(resultA, "Device A must execute command");
    assert.equal(resultA.status, "SUCCESS");
    assert.deepEqual(resultA.result, { type: "PONG" });
  });

  // Test 7: Replay Protection (Duplicate Command Rejection)
  await test("7. Android Replay Protection (Duplicate commandId Rejected as DUPLICATE)", async () => {
    const cmdIdReplay = `cmd_${crypto.randomBytes(12).toString("hex")}`;
    const commandPayload: DeviceCommand = {
      commandId: cmdIdReplay,
      targetDeviceId: devC.deviceId,
      commandType: "PING",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 45_000,
      payload: {},
      source: "ultron-web",
    };

    // First arrival: should succeed
    const firstResult = devC.handleBroadcastMessage(commandPayload);
    assert.ok(firstResult);
    assert.equal(firstResult.status, "SUCCESS");

    // Second arrival of identical commandId: MUST be rejected as DUPLICATE
    const secondResult = devC.handleBroadcastMessage(commandPayload);
    assert.ok(secondResult);
    assert.equal(secondResult.status, "DUPLICATE");
    assert.ok(secondResult.error?.includes("already been processed"));
  });

  // Test 8: Expired Command Rejection
  await test("8. Android Expiry Validation (Expired Command Rejected as EXPIRED)", async () => {
    const cmdIdExpired = `cmd_${crypto.randomBytes(12).toString("hex")}`;
    const commandPayload: DeviceCommand = {
      commandId: cmdIdExpired,
      targetDeviceId: devA.deviceId,
      commandType: "PING",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: Date.now() - 15_000, // Expired 15s ago
      payload: {},
      source: "ultron-web",
    };

    const result = devA.handleBroadcastMessage(commandPayload);
    assert.ok(result);
    assert.equal(result.status, "EXPIRED");
    assert.ok(result.error?.includes("expired before processing"));
  });

  // Test 9: Android Companion Allowlist Enforcement (Non-PING rejected on device)
  await test("9. Android Allowlist Enforcement (Unknown Command Rejected as FAILED)", async () => {
    const cmdIdDisallowed = `cmd_${crypto.randomBytes(12).toString("hex")}`;
    const commandPayload: any = {
      commandId: cmdIdDisallowed,
      targetDeviceId: devB.deviceId,
      commandType: "REBOOT_PHONE",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 45_000,
      payload: {},
      source: "ultron-web",
    };

    const result = devB.handleBroadcastMessage(commandPayload);
    assert.ok(result);
    assert.equal(result.status, "FAILED");
    assert.ok(result.error?.includes("Unsupported commandType"));
  });

  // Test 10: Zero Token Leakage Across Entire Command Pipeline
  await test("10. Zero Token Leakage Across Entire Command Pipeline", async () => {
    const { req, params } = createMockCommandRequest(
      devA.deviceId,
      { commandType: "PING", payload: {} },
      testUserId
    );
    const res = await commandsRoute(req, { params });
    const responseText = await res.text();

    assert.equal(
      responseText.includes(pairedA.deviceAuthToken),
      false,
      "DeviceAuthToken must NOT be leaked in command response"
    );
    const tokenHash = crypto.createHash("sha256").update(pairedA.deviceAuthToken.trim()).digest("hex");
    assert.equal(
      responseText.includes(tokenHash),
      false,
      "Device token hash must NOT be leaked in command response"
    );

    // Verify command payload contains no secrets
    const commandPayload: DeviceCommand = {
      commandId: "cmd_leak_check",
      targetDeviceId: devA.deviceId,
      commandType: "PING",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 45_000,
      payload: {},
      source: "ultron-web",
    };
    const serialized = JSON.stringify(commandPayload);
    assert.equal(serialized.includes(pairedA.deviceAuthToken), false);
  });

  // Test 11: Replay Cache Bounded Size (Max 500 entries)
  await test("11. Replay Cache Bounded Size (Evicts Eldest Past 500 Entries)", async () => {
    const boundedDev = new SimulatedAndroidCompanion("dev_bounded_test", "Memory Guard");

    // Insert 505 commands
    for (let i = 0; i < 505; i++) {
      boundedDev.handleBroadcastMessage({
        commandId: `cmd_bounded_${i}`,
        targetDeviceId: "dev_bounded_test",
        commandType: "PING",
        expiresAt: Date.now() + 60_000,
      });
    }

    assert.equal(boundedDev.replayCache.size, 500, "Cache size must be capped at 500");
    // Earliest entries (cmd_bounded_0 through cmd_bounded_4) should have been evicted
    assert.equal(boundedDev.replayCache.has("cmd_bounded_0"), false, "cmd_bounded_0 must have been evicted");
    assert.equal(boundedDev.replayCache.has("cmd_bounded_504"), true, "Latest command must be in cache");
  });

  // Summary
  console.log("\n-------------------------------------------------");
  console.log(`RESULTS: ${passed}/${total} Phase 12 Step 1 tests passed.`);
  console.log("-------------------------------------------------\n");

  if (passed !== total) {
    process.exit(1);
  }
  process.exit(0);
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
