import assert from "node:assert/strict";
import WebSocket from "ws";
import {
  createPairingSession,
  claimPairingSession,
  listUserDevices,
  recordDeviceHeartbeat,
  verifyDeviceToken,
  unpairDevice,
  _clearPairingSessionsForTest,
} from "../lib/db/deviceStore";
import { POST as createPairingRoute } from "../app/api/devices/pairing/create/route";
import { POST as claimPairingRoute } from "../app/api/devices/pairing/claim/route";
import { GET as listDevicesRoute } from "../app/api/devices/route";
import { POST as heartbeatRoute } from "../app/api/devices/heartbeat/route";
import { DELETE as unpairRoute } from "../app/api/devices/[deviceId]/route";
import {
  startDeviceWebSocketServer,
  stopDeviceWebSocketServer,
  getDeviceWsPort,
} from "../lib/deviceWsServer";
import { getGeminiModel, DEFAULT_GEMINI_MODEL } from "../lib/geminiService";
import { getElevenLabsPublicConfig } from "../lib/elevenlabsService";

console.log("==========================================");
console.log("   ULTRON PHASE 11 AUTOMATED TEST SUITE   ");
console.log("==========================================\n");

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
  _clearPairingSessionsForTest();

  // Test 1: Pairing Session Generation
  await test("1. Cryptographic Single-Use 5-Minute Pairing Session", () => {
    const userId = "usr_pair_test_1";
    const session = createPairingSession(userId);

    assert.ok(session.code, "Code must exist");
    assert.equal(session.code.length, 6, "Code should be 6 characters");
    assert.equal(session.code, session.code.toUpperCase(), "Code must be uppercase");
    assert.ok(session.expiresAt > Date.now(), "expiresAt must be in the future");
    assert.equal(session.expiresInSeconds, 300, "TTL must be 300 seconds (5 min)");

    const session2 = createPairingSession(userId);
    assert.notEqual(session.code, session2.code, "Codes must be unique");
  });

  // Test 2: Pairing Claim Flow
  await test("2. Pairing Claim Execution & Single-Use Enforcement", async () => {
    const userId = "usr_claim_test_1";
    const session = createPairingSession(userId);

    // Valid claim
    const result = await claimPairingSession(
      session.code,
      "Pixel 8 Pro",
      "Android",
      "1.0.0"
    );

    assert.ok(result.device.deviceId.startsWith("dev_"), "Device ID must start with dev_");
    assert.equal(result.device.userId, userId, "Device must bind to the user");
    assert.equal(result.device.deviceName, "Pixel 8 Pro");
    assert.equal(result.device.platform, "Android");
    assert.equal(result.device.connectionStatus, "connected");
    assert.ok(result.deviceAuthToken.startsWith("ultron_dev_"), "Token must start with ultron_dev_");

    // Single-use rejection: claim again with same code
    await assert.rejects(
      async () => {
        await claimPairingSession(session.code, "Pixel 8 Pro");
      },
      /already been used|Invalid or unknown/
    );

    // Invalid code rejection
    await assert.rejects(
      async () => {
        await claimPairingSession("BOGUS9", "Hacker Device");
      },
      /Invalid or unknown/
    );
  });

  // Test 3: Multi-User Device Isolation
  await test("3. Strict Multi-User Device Isolation (User A vs User B)", async () => {
    const userA = "usr_iso_a_" + Date.now();
    const userB = "usr_iso_b_" + Date.now();

    const sessionA = createPairingSession(userA);
    const sessionB = createPairingSession(userB);

    const devA = await claimPairingSession(sessionA.code, "User A Galaxy S24");
    const devB = await claimPairingSession(sessionB.code, "User B OnePlus 12");

    // User A lists devices
    const listA = await listUserDevices(userA);
    assert.equal(listA.length, 1);
    assert.equal(listA[0].deviceId, devA.device.deviceId);
    assert.equal(listA[0].deviceName, "User A Galaxy S24");

    // User B lists devices
    const listB = await listUserDevices(userB);
    assert.equal(listB.length, 1);
    assert.equal(listB[0].deviceId, devB.device.deviceId);
    assert.equal(listB[0].deviceName, "User B OnePlus 12");

    // User A cannot unpair User B's device
    const unpairAttempt = await unpairDevice(userA, devB.device.deviceId);
    assert.equal(unpairAttempt, false, "User A must not be permitted to unpair User B device");

    // Clean up
    await unpairDevice(userA, devA.device.deviceId);
    await unpairDevice(userB, devB.device.deviceId);
  });

  // Test 4: Heartbeat & Connection Tracking
  await test("4. Device Heartbeat Verification & Status Tracking", async () => {
    const user = "usr_heartbeat_" + Date.now();
    const session = createPairingSession(user);
    const claimed = await claimPairingSession(session.code, "Heartbeat Device");

    // Verify token
    const verified = await verifyDeviceToken(claimed.deviceAuthToken);
    assert.ok(verified !== null);
    assert.equal(verified?.deviceId, claimed.device.deviceId);

    // Record heartbeat
    const hb = await recordDeviceHeartbeat(claimed.deviceAuthToken);
    assert.ok(hb !== null);
    assert.equal(hb?.connectionStatus, "connected");
    assert.ok(hb?.lastSeenAt);

    // Invalid token heartbeat rejected
    const badHb = await recordDeviceHeartbeat("invalid_token_12345");
    assert.equal(badHb, null);

    await unpairDevice(user, claimed.device.deviceId);
  });

  // Test 5: HTTP API Endpoints Integration
  await test("5. HTTP Route Handlers Integration (/api/devices/pairing & /api/devices)", async () => {
    const testUser = "usr_http_api_" + Date.now();

    // 1. POST /api/devices/pairing/create
    const createReq = new Request("http://localhost:3000/api/devices/pairing/create", {
      method: "POST",
      headers: { "x-ultron-user-id": testUser },
    });
    const createRes = await createPairingRoute(createReq);
    assert.equal(createRes.status, 200);
    const createData = await createRes.json();
    assert.equal(createData.success, true);
    assert.ok(createData.code);
    assert.equal(createData.expiresInSeconds, 300);

    // 2. POST /api/devices/pairing/claim
    const claimReq = new Request("http://localhost:3000/api/devices/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: createData.code,
        deviceName: "Test Companion Phone",
        platform: "Android",
        appVersion: "1.0.0",
      }),
    });
    const claimRes = await claimPairingRoute(claimReq);
    assert.equal(claimRes.status, 200);
    const claimData = await claimRes.json();
    assert.equal(claimData.success, true);
    assert.ok(claimData.deviceId);
    assert.ok(claimData.deviceAuthToken);

    // 3. GET /api/devices
    const listReq = new Request("http://localhost:3000/api/devices", {
      method: "GET",
      headers: { "x-ultron-user-id": testUser },
    });
    const listRes = await listDevicesRoute(listReq);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.devices.length, 1);
    assert.equal(listData.devices[0].deviceId, claimData.deviceId);
    assert.ok(!("deviceAuthToken" in listData.devices[0]), "Token must never be leaked in list");

    // 4. POST /api/devices/heartbeat
    const hbReq = new Request("http://localhost:3000/api/devices/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${claimData.deviceAuthToken}`,
      },
    });
    const hbRes = await heartbeatRoute(hbReq);
    assert.equal(hbRes.status, 200);
    const hbData = await hbRes.json();
    assert.equal(hbData.success, true);
    assert.equal(hbData.connectionStatus, "connected");

    // 5. DELETE /api/devices/[deviceId]
    const unpairReq = new Request(`http://localhost:3000/api/devices/${claimData.deviceId}`, {
      method: "DELETE",
      headers: { "x-ultron-user-id": testUser },
    });
    const unpairRes = await unpairRoute(unpairReq, {
      params: Promise.resolve({ deviceId: claimData.deviceId }),
    });
    assert.equal(unpairRes.status, 200);

    // 6. Token revocation: subsequent heartbeat fails with 401
    const postUnpairHb = await heartbeatRoute(hbReq);
    assert.equal(postUnpairHb.status, 401);
  });

  // Test 6: Real-time WebSocket Protocol & Heartbeat
  await test("6. Real-time WebSocket Server Protocol & Ping/Pong", async () => {
    const wsPort = getDeviceWsPort();
    startDeviceWebSocketServer(wsPort);

    const user = "usr_ws_test_" + Date.now();
    const session = createPairingSession(user);
    const claimed = await claimPairingSession(session.code, "WebSocket Android Phone");

    await new Promise<void>((resolve, reject) => {
      const wsUrl = `ws://localhost:${wsPort}/?token=${claimed.deviceAuthToken}`;
      const ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        // Connected to WS server
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "authenticated") {
          assert.equal(msg.deviceId, claimed.device.deviceId);
          // Send ping now that connection is authenticated
          ws.send(JSON.stringify({ type: "ping" }));
        } else if (msg.type === "pong") {
          assert.equal(msg.deviceId, claimed.device.deviceId);
          ws.close(1000);
          resolve();
        }
      });

      ws.on("error", (err) => {
        reject(err);
      });
    });

    await unpairDevice(user, claimed.device.deviceId);
    await stopDeviceWebSocketServer();
  });

  // Test 7: Zero Plaintext Token Storage
  await test("7. Zero Raw Token Leakage in Public Interfaces", async () => {
    const user = "usr_token_leak_" + Date.now();
    const session = createPairingSession(user);
    const claimed = await claimPairingSession(session.code, "Leak Test Phone");

    const list = await listUserDevices(user);
    const stringified = JSON.stringify(list);

    assert.ok(!stringified.includes(claimed.deviceAuthToken), "Raw token must not appear in JSON");
    assert.ok(!stringified.includes("ultron_dev_"), "Prefix must not appear in JSON");

    await unpairDevice(user, claimed.device.deviceId);
  });

  // Test 8: Regression Check for Phase 9 & Phase 10
  await test("8. Phase 9 & Phase 10 Core Integrity Preserved", () => {
    assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.6-flash");
    assert.equal(getGeminiModel(), "gemini-3.6-flash");

    const elConfig = getElevenLabsPublicConfig();
    assert.equal(elConfig.voiceName, "George");
    assert.equal(elConfig.modelId, "eleven_flash_v2_5");
  });

  console.log("\n------------------------------------------");
  console.log(`RESULTS: ${passed}/${total} Phase 11 tests passed.`);
  console.log("------------------------------------------\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
