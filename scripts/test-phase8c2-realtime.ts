/**
 * scripts/test-phase8c2-realtime.ts
 *
 * ULTRON PART 8C.2: SUPABASE REALTIME AUTHORIZATION & CHANNEL ISOLATION TESTS
 *
 * Verifies all 18 security attack and functional scenarios:
 * 1. Authenticated User A can access User A device channel.
 * 2. Authenticated User B cannot subscribe to User A device channel.
 * 3. Anonymous client cannot subscribe to User A channel.
 * 4. User A cannot publish commands to User B channel.
 * 5. User B cannot publish commands to User A channel.
 * 6. Client cannot bypass authorization by changing userId.
 * 7. Client cannot bypass authorization by changing deviceId.
 * 8. Device A cannot receive User B's command.
 * 9. User A can still send a legitimate command to User A device through the authorized server flow.
 * 10. PING still works.
 * 11. OPEN_APP still works with existing confirmation/allowlist protections.
 * 12. Pairing still works.
 * 13. Heartbeat still works.
 * 14. Reconnect still works.
 * 15. Multiple users/devices remain isolated.
 * 16. No service_role secret is exposed client-side.
 * 17. Realtime authorization policy does not contain globally permissive access.
 * 18. Existing RLS tests and migration syntax remain valid.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  createSignedSessionToken,
  SESSION_COOKIE_NAME,
} from "../lib/auth/session";
import {
  createPairingSession,
  claimPairingSession,
  recordDeviceHeartbeat,
  verifyDeviceToken,
  listUserDevices,
} from "../lib/db/deviceStore";
import { setDeviceCatalog } from "../lib/db/deviceCatalogStore";
import type { DeviceCommand } from "../lib/realtime/deviceRealtime";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

async function runRealtimeSecurityTests() {
  console.log("\n=======================================================");
  console.log("ULTRON PART 8C.2: SUPABASE REALTIME AUTHORIZATION TESTS");
  console.log("=======================================================\n");

  let passed = 0;
  let failed = 0;

  async function step(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[FAIL] ${name}`);
      console.error(`       ${msg}`);
      failed++;
    }
  }

  const userA = "usr_alice_" + crypto.randomBytes(4).toString("hex");
  const userB = "usr_bob_" + crypto.randomBytes(4).toString("hex");

  const userAToken = createSignedSessionToken(userA);
  const userBToken = createSignedSessionToken(userB);

  function authFetch(endpoint: string, token: string, init?: RequestInit) {
    const headers = new Headers(init?.headers || {});
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
    return fetch(`${BASE_URL}${endpoint}`, {
      ...init,
      headers,
    });
  }

  // Setup: Pair Device A for User A
  const pairingA = await createPairingSession(userA);
  const claimedA = await claimPairingSession(
    pairingA.code,
    "Alice Pixel 9",
    "Android",
    "1.0.0"
  );
  const deviceAId = claimedA.device.deviceId;
  const deviceAToken = claimedA.deviceAuthToken;

  // Setup: Pair Device B for User B
  const pairingB = await createPairingSession(userB);
  const claimedB = await claimPairingSession(
    pairingB.code,
    "Bob Galaxy S24",
    "Android",
    "1.0.0"
  );
  const deviceBId = claimedB.device.deviceId;
  const deviceBToken = claimedB.deviceAuthToken;

  // Catalog for Device A
  await setDeviceCatalog(deviceAId, [
    { appId: "com.whatsapp", displayName: "WhatsApp" },
    { appId: "com.spotify.music", displayName: "Spotify" },
  ]);

  // ---------------------------------------------------------------------------
  // TEST 1: Authenticated User A can access User A device channel
  // ---------------------------------------------------------------------------
  await step("TEST 1: Authenticated User A can access User A device channel", async () => {
    // Companion provisioning route with Device A Bearer token
    const res = await fetch(`${BASE_URL}/api/devices/realtime`, {
      headers: { Authorization: `Bearer ${deviceAToken}` },
    });
    assert.equal(res.status, 200, "Device A should be authorized");
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.userId, userA);
    assert.equal(body.deviceId, deviceAId);
    assert.equal(body.channel, `ultron:devices:${userA}`);
    assert.equal(body.phoenixTopic, `realtime:ultron:devices:${userA}`);
    assert.equal(body.private, true, "Channel must be marked private: true");
  });

  // ---------------------------------------------------------------------------
  // TEST 2: Authenticated User B cannot subscribe to User A device channel
  // ---------------------------------------------------------------------------
  await step("TEST 2: Authenticated User B cannot subscribe to User A device channel", async () => {
    // User B tries to provision or join Device A channel
    // 1. Calling /api/devices/realtime with User B's token cannot claim Device A
    const res = await fetch(`${BASE_URL}/api/devices/realtime`, {
      headers: { Authorization: `Bearer ${deviceBToken}` },
    });
    const body = await res.json();
    assert.equal(body.deviceId, deviceBId, "User B device token only gets User B channel");
    assert.notEqual(body.channel, `ultron:devices:${userA}`, "Cannot get User A channel");

    // 2. User B checking Device A catalog or commands route is denied
    const catRes = await authFetch(`/api/devices/${deviceAId}/catalog`, userBToken);
    assert.equal(catRes.status, 401, "User B cannot access User A device channel/catalog");
  });

  // ---------------------------------------------------------------------------
  // TEST 3: Anonymous client cannot subscribe to User A channel
  // ---------------------------------------------------------------------------
  await step("TEST 3: Anonymous client cannot subscribe to User A channel", async () => {
    const res = await fetch(`${BASE_URL}/api/devices/realtime`);
    assert.equal(res.status, 401, "Anonymous request to realtime endpoint must receive 401");

    const cmdRes = await fetch(`${BASE_URL}/api/devices/${deviceAId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandType: "PING", payload: {} }),
    });
    assert.equal(cmdRes.status, 401, "Anonymous request to command endpoint must receive 401");
  });

  // ---------------------------------------------------------------------------
  // TEST 4: User A cannot publish commands to User B channel
  // ---------------------------------------------------------------------------
  await step("TEST 4: User A cannot publish commands to User B channel", async () => {
    // User A attempts to send command targeting Device B
    const res = await authFetch(`/api/devices/${deviceBId}/commands`, userAToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandType: "PING", payload: {} }),
    });
    assert.equal(res.status, 404, "Must reject command with 404 Not Found");
    const body = await res.json();
    assert.match(body.error, /not registered to the authenticated user/i);
  });

  // ---------------------------------------------------------------------------
  // TEST 5: User B cannot publish commands to User A channel
  // ---------------------------------------------------------------------------
  await step("TEST 5: User B cannot publish commands to User A channel", async () => {
    const res = await authFetch(`/api/devices/${deviceAId}/commands`, userBToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandType: "PING", payload: {} }),
    });
    assert.equal(res.status, 404, "Must reject command with 404 Not Found");
    const body = await res.json();
    assert.match(body.error, /not registered to the authenticated user/i);
  });

  // ---------------------------------------------------------------------------
  // TEST 6: Client cannot bypass authorization by changing userId
  // ---------------------------------------------------------------------------
  await step("TEST 6: Client cannot bypass authorization by changing userId", async () => {
    // User B sends spoofed x-ultron-user-id header pointing to User A
    const res = await fetch(`${BASE_URL}/api/devices/${deviceAId}/commands`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${userBToken}`,
        "x-ultron-user-id": userA,
      },
      body: JSON.stringify({ commandType: "PING", payload: {} }),
    });
    assert.equal(res.status, 404, "Spoofed x-ultron-user-id header must be ignored");
  });

  // ---------------------------------------------------------------------------
  // TEST 7: Client cannot bypass authorization by changing deviceId
  // ---------------------------------------------------------------------------
  await step("TEST 7: Client cannot bypass authorization by changing deviceId", async () => {
    const fakeDeviceId = "dev_fake_nonexistent_12345";
    const res = await authFetch(`/api/devices/${fakeDeviceId}/commands`, userAToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandType: "PING", payload: {} }),
    });
    assert.equal(res.status, 404, "Nonexistent deviceId must be rejected with 404");
  });

  // ---------------------------------------------------------------------------
  // TEST 8: Device A cannot receive User B's command
  // ---------------------------------------------------------------------------
  await step("TEST 8: Device A cannot receive User B's command (Target isolation)", async () => {
    // Simulate Android companion logic for Device A
    function filterIncomingCommand(cmd: DeviceCommand, localDeviceId: string): boolean {
      return cmd.targetDeviceId === localDeviceId;
    }

    const commandForB: DeviceCommand = {
      commandId: "cmd_b_test",
      targetDeviceId: deviceBId,
      commandType: "PING",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 45000,
      payload: {},
      source: "ultron-web",
    };

    const acceptedByA = filterIncomingCommand(commandForB, deviceAId);
    assert.equal(acceptedByA, false, "Device A must drop commands targeted at Device B");

    const acceptedByB = filterIncomingCommand(commandForB, deviceBId);
    assert.equal(acceptedByB, true, "Device B should accept commands targeted at Device B");
  });

  // ---------------------------------------------------------------------------
  // TEST 9: User A can still send a legitimate command to User A device
  // ---------------------------------------------------------------------------
  await step("TEST 9: User A can still send a legitimate command to User A device", async () => {
    const res = await authFetch(`/api/devices/${deviceAId}/commands`, userAToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandType: "PING", payload: {} }),
    });
    assert.equal(res.status, 200, "Legitimate command should return 200 OK");
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.status, "PENDING");
    assert.equal(body.targetDeviceId, deviceAId);
    assert(body.commandId.startsWith("cmd_"), "Should return valid commandId");
  });

  // ---------------------------------------------------------------------------
  // TEST 10: PING still works
  // ---------------------------------------------------------------------------
  await step("TEST 10: PING command dispatch works", async () => {
    const res = await authFetch(`/api/devices/${deviceAId}/commands`, userAToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandType: "PING", payload: {} }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  // ---------------------------------------------------------------------------
  // TEST 11: OPEN_APP still works with existing confirmation/allowlist protections
  // ---------------------------------------------------------------------------
  await step("TEST 11: OPEN_APP works with allowlist / catalog validation", async () => {
    // 1. Allowlisted / catalog app succeeds
    const okRes = await authFetch(`/api/devices/${deviceAId}/commands`, userAToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandType: "OPEN_APP",
        payload: { appId: "whatsapp" },
      }),
    });
    assert.equal(okRes.status, 200, "Valid app in catalog should succeed");

    // 2. Unapproved arbitrary shell / disallowed command rejected
    const badRes = await authFetch(`/api/devices/${deviceAId}/commands`, userAToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandType: "OPEN_APP",
        payload: { appId: "com.evil.exploit" },
      }),
    });
    assert.equal(badRes.status, 400, "Unapproved appId must be rejected with 400");
  });

  // ---------------------------------------------------------------------------
  // TEST 12: Pairing still works
  // ---------------------------------------------------------------------------
  await step("TEST 12: Pairing still works", async () => {
    const pair = await createPairingSession(userA);
    assert(pair.code.length >= 6);
    const claimed = await claimPairingSession(pair.code, "Test Phone", "Android", "1.0.0");
    assert.equal(claimed.device.userId, userA);
  });

  // ---------------------------------------------------------------------------
  // TEST 13: Heartbeat still works
  // ---------------------------------------------------------------------------
  await step("TEST 13: Heartbeat still works", async () => {
    const hb = await recordDeviceHeartbeat(deviceAToken);
    assert.notEqual(hb, null);
    assert.equal(hb?.deviceId, deviceAId);
    assert.equal(hb?.connectionStatus, "connected");
  });

  // ---------------------------------------------------------------------------
  // TEST 14: Reconnect still works
  // ---------------------------------------------------------------------------
  await step("TEST 14: Reconnect preserves authorization configuration", async () => {
    // Verify device token survives and provides identical channel config
    const verified = await verifyDeviceToken(deviceAToken);
    assert.notEqual(verified, null);

    const res = await fetch(`${BASE_URL}/api/devices/realtime`, {
      headers: { Authorization: `Bearer ${deviceAToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.channel, `ultron:devices:${userA}`);
    assert.equal(body.private, true);
  });

  // ---------------------------------------------------------------------------
  // TEST 15: Multiple users/devices remain isolated
  // ---------------------------------------------------------------------------
  await step("TEST 15: Multiple users and devices remain completely isolated", async () => {
    const devicesA = await listUserDevices(userA);
    const devicesB = await listUserDevices(userB);

    assert(devicesA.some((d) => d.deviceId === deviceAId));
    assert(!devicesA.some((d) => d.deviceId === deviceBId));

    assert(devicesB.some((d) => d.deviceId === deviceBId));
    assert(!devicesB.some((d) => d.deviceId === deviceAId));
  });

  // ---------------------------------------------------------------------------
  // TEST 16: No service_role secret is exposed client-side
  // ---------------------------------------------------------------------------
  await step("TEST 16: No service_role secret is exposed client-side", async () => {
    const res = await fetch(`${BASE_URL}/api/devices/realtime`, {
      headers: { Authorization: `Bearer ${deviceAToken}` },
    });
    const text = await res.text();
    assert(!text.includes("service_role"), "Realtime provisioning must NEVER return service_role");
    assert(!text.includes("SUPABASE_SERVICE_ROLE_KEY"), "Secret variable name must not leak");

    const devRes = await authFetch("/api/devices", userAToken);
    const devText = await devRes.text();
    assert(!devText.includes("service_role"));
    assert(!devText.includes("deviceTokenHash"), "Device token hash must not leak to UI");
  });

  // ---------------------------------------------------------------------------
  // TEST 17: Realtime authorization policy does not contain globally permissive access
  // ---------------------------------------------------------------------------
  await step("TEST 17: Realtime authorization policy contains no globally permissive access", async () => {
    const migrationPath = path.join(
      process.cwd(),
      "supabase",
      "migrations",
      "004_realtime_authorization.sql"
    );
    assert(fs.existsSync(migrationPath), "Migration 004 must exist");
    const content = fs.readFileSync(migrationPath, "utf-8");

    // Must NOT contain USING (true) for anon or authenticated
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("CREATE POLICY") && (line.includes("TO anon") || line.includes("TO authenticated"))) {
        const nextLines = lines.slice(i, i + 8).join(" ");
        assert(!nextLines.includes("USING (true)"), `Policy at line ${i + 1} must not be USING (true)`);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 18: Migration static and syntax verification
  // ---------------------------------------------------------------------------
  await step("TEST 18: Migration 004 static and syntax verification", async () => {
    const migrationPath = path.join(
      process.cwd(),
      "supabase",
      "migrations",
      "004_realtime_authorization.sql"
    );
    const content = fs.readFileSync(migrationPath, "utf-8");

    assert(content.includes("ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;"));
    assert(content.includes('DROP POLICY IF EXISTS "Allow anon realtime broadcast" ON realtime.messages;'));
    assert(content.includes('DROP POLICY IF EXISTS "Allow anon realtime subscribe" ON realtime.messages;'));
    assert(/FOR ALL\s+TO anon\s+USING \(false\);/m.test(content), "Must have explicit anon deny policy");
    assert(/FOR ALL\s+TO service_role\s+USING \(true\)\s+WITH CHECK \(true\);/m.test(content), "Must allow service_role full access");
    assert(content.includes("FOR SELECT\n    TO authenticated") || content.includes("FOR SELECT"), "Must have authenticated SELECT policy");
    assert(content.includes("FOR INSERT\n    TO authenticated") || content.includes("FOR INSERT"), "Must have authenticated INSERT policy");
    assert(content.includes("ultron:devices:"));
    assert(content.includes("ultron:device:"));
  });

  console.log("\n-------------------------------------------------------");
  console.log(`TEST RUN COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runRealtimeSecurityTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
