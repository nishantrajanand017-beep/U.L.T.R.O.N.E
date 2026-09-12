import assert from "node:assert/strict";
import {
  createPairingSession,
  claimPairingSession,
  verifyDeviceToken,
  unpairDevice,
  _clearPairingSessionsForTest,
} from "../lib/db/deviceStore";
import { GET as realtimeRoute } from "../app/api/devices/realtime/route";
import { GET as legacyWsRoute } from "../app/api/devices/ws/route";
import { GET as listDevicesRoute } from "../app/api/devices/route";
import { POST as heartbeatRoute } from "../app/api/devices/heartbeat/route";
import { stopDeviceWebSocketServer } from "../lib/deviceWsServer";

console.log("============================================");
console.log("   ULTRON PHASE 11.5 AUTOMATED TEST SUITE   ");
console.log("============================================\n");

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

  // Test 1: Realtime endpoint authentication & channel provisioning
  await test("1. Realtime Provisioning with Valid Device Token", async () => {
    const userId = "usr_realtime_test_1";
    const session = await createPairingSession(userId);
    const claimed = await claimPairingSession(
      session.code,
      "Pixel 9 Pro",
      "Android",
      "1.0.0"
    );

    assert.ok(claimed, "Claiming must succeed");

    const req = new Request("http://localhost:3000/api/devices/realtime", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${claimed.deviceAuthToken}`,
      },
    });

    const res = await realtimeRoute(req);
    assert.equal(res.status, 200, "Response status must be 200 OK");

    const data = await res.json();
    assert.equal(data.success, true, "Must indicate success");
    assert.equal(data.channel, `ultron:devices:${userId}`, "Channel must be user-scoped");
    assert.equal(data.phoenixTopic, `realtime:ultron:devices:${userId}`, "Phoenix topic must match format");
    assert.equal(data.deviceId, claimed.device.deviceId, "DeviceId must match");
    assert.equal(data.userId, userId, "UserId must match");
    assert.ok(data.realtimeWsUrl, "Realtime WebSocket URL must be present");
    assert.ok(typeof data.heartbeatIntervalMs === "number", "Heartbeat interval must be number");
  });

  // Test 2: Immediate rejection of unauthorized/missing tokens
  await test("2. Unauthorized Request Rejection (Missing/Invalid Token)", async () => {
    // 2a. Missing Authorization header
    const reqMissing = new Request("http://localhost:3000/api/devices/realtime", {
      method: "GET",
    });
    const resMissing = await realtimeRoute(reqMissing);
    assert.equal(resMissing.status, 401, "Must return 401 for missing header");

    // 2b. Malformed header
    const reqMalformed = new Request("http://localhost:3000/api/devices/realtime", {
      method: "GET",
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    const resMalformed = await realtimeRoute(reqMalformed);
    assert.equal(resMalformed.status, 401, "Must return 401 for non-Bearer auth");

    // 2c. Invalid / non-existent token
    const reqInvalid = new Request("http://localhost:3000/api/devices/realtime", {
      method: "GET",
      headers: { Authorization: "Bearer bogus_device_token_xyz_999" },
    });
    const resInvalid = await realtimeRoute(reqInvalid);
    assert.equal(resInvalid.status, 401, "Must return 401 for invalid token");
  });

  // Test 3: Revocation enforcement (Unpaired device cannot access Realtime)
  await test("3. Revocation Enforcement (Unpaired Device Rejection)", async () => {
    const userId = "usr_realtime_test_revoke";
    const session = await createPairingSession(userId);
    const claimed = await claimPairingSession(
      session.code,
      "Revocation Test Phone",
      "Android",
      "1.0.0"
    );

    assert.ok(claimed, "Pairing must succeed");

    // Verify token works initially
    const initialReq = new Request("http://localhost:3000/api/devices/realtime", {
      method: "GET",
      headers: { Authorization: `Bearer ${claimed.deviceAuthToken}` },
    });
    const initialRes = await realtimeRoute(initialReq);
    assert.equal(initialRes.status, 200, "Initial request must succeed");

    // Unpair device
    const unpairSuccess = await unpairDevice(userId, claimed.device.deviceId);
    assert.equal(unpairSuccess, true, "Unpairing must succeed");

    // Verify token is now completely rejected
    const revokedReq = new Request("http://localhost:3000/api/devices/realtime", {
      method: "GET",
      headers: { Authorization: `Bearer ${claimed.deviceAuthToken}` },
    });
    const revokedRes = await realtimeRoute(revokedReq);
    assert.equal(revokedRes.status, 401, "Revoked device must be rejected with 401");
  });

  // Test 4: Strict multi-user isolation
  await test("4. Multi-User Channel & Device Isolation", async () => {
    const userA = "usr_isolation_alpha";
    const userB = "usr_isolation_beta";

    const sessionA = await createPairingSession(userA);
    const deviceA = await claimPairingSession(sessionA.code, "Alpha Phone", "Android", "1.0.0");

    const sessionB = await createPairingSession(userB);
    const deviceB = await claimPairingSession(sessionB.code, "Beta Tablet", "Android", "1.0.0");

    assert.ok(deviceA && deviceB, "Both devices must be paired");

    // Query Realtime config for Device A
    const reqA = new Request("http://localhost:3000/api/devices/realtime", {
      method: "GET",
      headers: { Authorization: `Bearer ${deviceA.deviceAuthToken}` },
    });
    const resA = await realtimeRoute(reqA);
    const dataA = await resA.json();

    // Query Realtime config for Device B
    const reqB = new Request("http://localhost:3000/api/devices/realtime", {
      method: "GET",
      headers: { Authorization: `Bearer ${deviceB.deviceAuthToken}` },
    });
    const resB = await realtimeRoute(reqB);
    const dataB = await resB.json();

    assert.equal(dataA.channel, `ultron:devices:${userA}`, "Device A must belong only to User A channel");
    assert.equal(dataB.channel, `ultron:devices:${userB}`, "Device B must belong only to User B channel");
    assert.notEqual(dataA.channel, dataB.channel, "User channels must be strictly distinct");
  });

  // Test 5: Zero Raw Token Leakage
  await test("5. Zero Raw Token Leakage in Public Interfaces", async () => {
    const userId = "usr_leak_test_realtime";
    const session = await createPairingSession(userId);
    const claimed = await claimPairingSession(session.code, "Security Test Device", "Android", "1.0.0");
    assert.ok(claimed, "Pairing must succeed");

    const req = new Request("http://localhost:3000/api/devices/realtime", {
      method: "GET",
      headers: { Authorization: `Bearer ${claimed.deviceAuthToken}` },
    });
    const res = await realtimeRoute(req);
    const text = await res.text();

    // Assert raw token is nowhere in response payload
    assert.equal(text.includes(claimed.deviceAuthToken), false, "Raw deviceAuthToken must NOT be leaked in realtime payload");
    // Assert pairing code is nowhere in response
    assert.equal(text.includes(session.code), false, "Pairing code must NOT be in realtime payload");
  });

  // Test 6: Legacy WebSocket Route Compatibility
  await test("6. Backward Compatibility for Legacy /api/devices/ws", async () => {
    const req = new Request("http://localhost:3000/api/devices/ws", {
      method: "GET",
      headers: { host: "localhost:3000" },
    });
    const res = await legacyWsRoute(req);
    assert.equal(res.status, 200, "Legacy route must return 200 OK");

    const data = await res.json();
    assert.equal(data.success, true, "Legacy route must return success");
    assert.equal(data.legacy, true, "Must be tagged as legacy");
    assert.equal(data.realtimeEndpoint, "/api/devices/realtime", "Must point to modern realtime endpoint");
    assert.ok(data.wsUrl, "Must provide fallback wsUrl");
  });

  // Test 7: REST Heartbeat Continuity
  await test("7. REST Heartbeat Continuous Fallback Verification", async () => {
    const userId = "usr_rest_heartbeat_test";
    const session = await createPairingSession(userId);
    const claimed = await claimPairingSession(session.code, "Heartbeat Companion", "Android", "1.0.0");
    assert.ok(claimed, "Claiming must succeed");

    const hbReq = new Request("http://localhost:3000/api/devices/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${claimed.deviceAuthToken}` },
      body: JSON.stringify({}),
    });

    const hbRes = await heartbeatRoute(hbReq);
    assert.equal(hbRes.status, 200, "Heartbeat must return 200 OK");

    const hbData = await hbRes.json();
    assert.equal(hbData.success, true, "Heartbeat must succeed");
    assert.equal(hbData.connectionStatus, "connected", "Status must remain connected");
  });

  // Test 8: Production Route Protection (Zero Port 3001 Exposure on Vercel)
  await test("8. Production Route Protection (Zero Port 3001 Exposure on Vercel)", async () => {
    // 8a: /api/devices/ws on production host
    const reqProdWs = new Request("https://u-l-t-r-o-n-e.vercel.app/api/devices/ws", {
      method: "GET",
      headers: { host: "u-l-t-r-o-n-e.vercel.app" },
    });
    const resProdWs = await legacyWsRoute(reqProdWs);
    assert.equal(resProdWs.status, 200, "Must return 200 OK");
    const dataProdWs = await resProdWs.json();
    assert.equal(dataProdWs.wsUrl, null, "wsUrl must be null for production host (no :3001)");
    assert.equal(dataProdWs.realtimeEndpoint, "/api/devices/realtime", "Must point to realtime endpoint");

    // 8b: /api/devices/realtime on production host
    const userId = "usr_prod_guard_test";
    const session = await createPairingSession(userId);
    const claimed = await claimPairingSession(session.code, "Production Guard Phone", "Android", "1.0.0");
    assert.ok(claimed);

    const reqProdRt = new Request("https://u-l-t-r-o-n-e.vercel.app/api/devices/realtime", {
      method: "GET",
      headers: {
        host: "u-l-t-r-o-n-e.vercel.app",
        Authorization: `Bearer ${claimed.deviceAuthToken}`,
      },
    });
    const resProdRt = await realtimeRoute(reqProdRt);
    assert.equal(resProdRt.status, 200);
    const dataProdRt = await resProdRt.json();
    assert.equal(dataProdRt.realtimeWsUrl.includes(":3001"), false, "realtimeWsUrl must never contain :3001 in production");
    assert.equal(dataProdRt.legacyWsUrl, undefined, "legacyWsUrl must be omitted in production");
  });

  stopDeviceWebSocketServer();

  // Summary
  console.log("\n--------------------------------------------");
  console.log(`RESULTS: ${passed}/${total} Phase 11.5 tests passed.`);
  console.log("--------------------------------------------\n");

  if (passed !== total) {
    process.exit(1);
  }
  process.exit(0);
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
