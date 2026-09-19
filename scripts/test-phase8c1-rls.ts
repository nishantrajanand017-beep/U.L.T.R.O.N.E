/**
 * scripts/test-phase8c1-rls.ts
 *
 * ULTRON PART 8C.1: SUPABASE RLS & USER DATA ISOLATION VERIFICATION SUITE
 *
 * Verifies that:
 * 1. User A can access User A device.
 * 2. User B cannot SELECT User A device.
 * 3. User B cannot UPDATE User A device.
 * 4. User B cannot DELETE User A device.
 * 5. User B cannot modify User A catalog.
 * 6. User B cannot read User A catalog.
 * 7. User B cannot read User A pairing session.
 * 8. User B cannot modify User A pairing session.
 * 9. User B cannot read User A memory.
 * 10. User B cannot modify User A memory.
 * 11. User B cannot delete User A memory.
 * 12. User B cannot read User A RAG document.
 * 13. User B cannot delete User A RAG document.
 * 14. User B cannot read User A RAG chunks.
 * 15. Anonymous access to private tables/endpoints is denied.
 * 16. Client-supplied userId cannot bypass ownership.
 * 17. Existing legitimate server-side operations still work.
 * 18. Database migration 003_secure_rls.sql defines complete, hardened RLS coverage.
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
  listUserDevices,
  unpairDevice,
  createPairingSession,
  claimPairingSession,
  recordDeviceHeartbeat,
  verifyDeviceToken,
  _clearPairingSessionsForTest,
} from "../lib/db/deviceStore";
import {
  getDeviceCatalog,
  setDeviceCatalog,
  findInDeviceCatalog,
} from "../lib/db/deviceCatalogStore";
import {
  saveMemory,
  getUserMemories,
  updateMemory,
  deleteMemory,
} from "../lib/memory/memoryStore";
import {
  createDocument,
  listDocuments,
  deleteDocument,
  searchChunks,
} from "../lib/rag/ragStore";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

async function runRlsTests() {
  console.log("\n=======================================================");
  console.log("ULTRON PART 8C.1: SUPABASE RLS & DATA ISOLATION TESTS");
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

  // Helper for authenticated fetch
  function authFetch(endpoint: string, token: string, init?: RequestInit) {
    const headers = new Headers(init?.headers || {});
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
    return fetch(`${BASE_URL}${endpoint}`, {
      ...init,
      headers,
    });
  }

  // Setup: Create device for User A via server pairing flow
  const pairingA = await createPairingSession(userA);
  const claimedA = await claimPairingSession(
    pairingA.code,
    "Alice Test Phone",
    "Android",
    "1.0.0"
  );
  const deviceAId = claimedA.device.deviceId;
  const deviceAToken = claimedA.deviceAuthToken;

  // Setup: Store catalog for User A's device
  await setDeviceCatalog(deviceAId, [
    { appId: "com.whatsapp", displayName: "WhatsApp" },
    { appId: "com.spotify.music", displayName: "Spotify" },
  ]);

  // Setup: Save memory for User A
  const memoryA = await saveMemory(
    userA,
    "profile",
    "codename",
    "Spectre-007"
  );

  // Setup: Add RAG document for User A
  const sampleChunks = [
    { chunkIndex: 0, content: "Quantum flux capacitors operating at 99.8% stability." },
    { chunkIndex: 1, content: "Primary defense matrix coordinates are Alpha-Niner." },
  ];
  const docHash = crypto
    .createHash("sha256")
    .update(sampleChunks.map((c) => c.content).join(""))
    .digest("hex");

  const docA = await createDocument(
    userA,
    "project_ultron_secret.md",
    "text/markdown",
    1024,
    docHash,
    sampleChunks
  );

  // ---------------------------------------------------------------------------
  // TEST 1: User A can access User A device
  // ---------------------------------------------------------------------------
  await step("TEST 1: User A can access User A device", async () => {
    const res = await authFetch("/api/devices", userAToken);
    assert.equal(res.status, 200, "Should return 200 OK");
    const body = await res.json();
    assert.equal(body.success, true);
    assert(Array.isArray(body.devices), "Should return devices array");
    const found = body.devices.some((d: any) => d.deviceId === deviceAId);
    assert.equal(found, true, "User A must see their own device");
  });

  // ---------------------------------------------------------------------------
  // TEST 2: User B cannot SELECT User A device
  // ---------------------------------------------------------------------------
  await step("TEST 2: User B cannot SELECT User A device", async () => {
    const res = await authFetch("/api/devices", userBToken);
    assert.equal(res.status, 200, "Should return 200 OK for User B");
    const body = await res.json();
    assert(Array.isArray(body.devices), "Should return devices array");
    const foundUserADevice = body.devices.some((d: any) => d.deviceId === deviceAId);
    assert.equal(foundUserADevice, false, "User B must NEVER see User A device");
  });

  // ---------------------------------------------------------------------------
  // TEST 3: User B cannot UPDATE User A device
  // ---------------------------------------------------------------------------
  await step("TEST 3: User B cannot UPDATE User A device", async () => {
    // Attempt to command or alter User A device as User B
    const cmdRes = await authFetch(`/api/devices/${deviceAId}/commands`, userBToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandType: "PING", payload: {} }),
    });
    assert.equal(cmdRes.status, 404, "Must reject command with 404 Not Found");
  });

  // ---------------------------------------------------------------------------
  // TEST 4: User B cannot DELETE User A device
  // ---------------------------------------------------------------------------
  await step("TEST 4: User B cannot DELETE User A device", async () => {
    const delRes = await authFetch(`/api/devices/${deviceAId}`, userBToken, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 404, "User B cannot delete User A device");

    // Verify User A device still exists
    const devicesA = await listUserDevices(userA);
    assert(devicesA.some((d) => d.deviceId === deviceAId), "User A device must still exist");
  });

  // ---------------------------------------------------------------------------
  // TEST 5: User B cannot modify User A catalog
  // ---------------------------------------------------------------------------
  await step("TEST 5: User B cannot modify User A catalog", async () => {
    const res = await authFetch(`/api/devices/${deviceAId}/catalog`, userBToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apps: [{ appId: "com.malicious.app", displayName: "Malware" }],
      }),
    });
    assert.equal(res.status, 401, "User B must be rejected with 401 Unauthorized");

    // Verify User A catalog remains pristine
    const pristine = await getDeviceCatalog(deviceAId);
    assert.equal(pristine.some((a) => a.appId === "com.malicious.app"), false);
  });

  // ---------------------------------------------------------------------------
  // TEST 6: User B cannot read User A catalog
  // ---------------------------------------------------------------------------
  await step("TEST 6: User B cannot read User A catalog", async () => {
    const res = await authFetch(`/api/devices/${deviceAId}/catalog`, userBToken);
    assert.equal(res.status, 401, "User B cannot view User A device catalog");
  });

  // ---------------------------------------------------------------------------
  // TEST 7: User B cannot read User A pairing session
  // ---------------------------------------------------------------------------
  await step("TEST 7: User B cannot read User A pairing session", async () => {
    const pairingSessionA2 = await createPairingSession(userA);
    // User B attempting to list or view devices will not see User A's pairing session
    const res = await authFetch("/api/devices", userBToken);
    const body = await res.json();
    assert.equal(body.devices.some((d: any) => d.code === pairingSessionA2.code), false);
  });

  // ---------------------------------------------------------------------------
  // TEST 8: User B cannot modify User A pairing session
  // ---------------------------------------------------------------------------
  await step("TEST 8: User B cannot modify User A pairing session", async () => {
    const pairingA3 = await createPairingSession(userA);
    // Even if an attacker knows the code, claim binds to session.userId (User A), never User B
    const claimed = await claimPairingSession(
      pairingA3.code,
      "Hacked Phone",
      "Android",
      "1.0.0"
    );
    assert.equal(claimed.device.userId, userA, "Claimed device MUST belong to User A, never User B");

    // And once used, cannot be reused
    await assert.rejects(
      async () => {
        await claimPairingSession(pairingA3.code, "Duplicate Phone", "Android", "1.0.0");
      },
      /already been used|invalid or unknown/i,
      "Used pairing code must not be reusable"
    );
  });

  // ---------------------------------------------------------------------------
  // TEST 9: User B cannot read User A memory
  // ---------------------------------------------------------------------------
  await step("TEST 9: User B cannot read User A memory", async () => {
    const res = await authFetch("/api/memories", userBToken);
    assert.equal(res.status, 200, "Should succeed for User B");
    const body = await res.json();
    assert(Array.isArray(body.memories), "Should return memories array");
    const foundA = body.memories.some((m: any) => m.id === memoryA.id || m.key === "codename");
    assert.equal(foundA, false, "User B must NEVER read User A memories");
  });

  // ---------------------------------------------------------------------------
  // TEST 10: User B cannot modify User A memory
  // ---------------------------------------------------------------------------
  await step("TEST 10: User B cannot modify User A memory", async () => {
    // Directly via updateMemory function
    const updated = await updateMemory(userB, memoryA.id, "Hacked-Value");
    assert.equal(updated, null, "updateMemory must return null when user does not own memory");

    // Verify User A memory is unchanged
    const userAMems = await getUserMemories(userA);
    const mem = userAMems.find((m) => m.id === memoryA.id);
    assert.equal(mem?.value, "Spectre-007", "Memory value must remain unchanged");
  });

  // ---------------------------------------------------------------------------
  // TEST 11: User B cannot delete User A memory
  // ---------------------------------------------------------------------------
  await step("TEST 11: User B cannot delete User A memory", async () => {
    const delRes = await authFetch(`/api/memories?id=${memoryA.id}`, userBToken, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 404, "Deleting another user's memory must return 404");

    // Verify memory still exists for User A
    const userAMems = await getUserMemories(userA);
    assert(userAMems.some((m) => m.id === memoryA.id), "Memory must still exist for User A");
  });

  // ---------------------------------------------------------------------------
  // TEST 12: User B cannot read User A RAG document
  // ---------------------------------------------------------------------------
  await step("TEST 12: User B cannot read User A RAG document", async () => {
    const res = await authFetch("/api/rag/documents", userBToken);
    assert.equal(res.status, 200, "Should succeed for User B");
    const body = await res.json();
    assert(Array.isArray(body.documents), "Should return documents array");
    const foundDocA = body.documents.some((d: any) => d.id === docA.id);
    assert.equal(foundDocA, false, "User B must NEVER see User A RAG document");
  });

  // ---------------------------------------------------------------------------
  // TEST 13: User B cannot delete User A RAG document
  // ---------------------------------------------------------------------------
  await step("TEST 13: User B cannot delete User A RAG document", async () => {
    const delRes = await authFetch(`/api/rag/documents?id=${docA.id}`, userBToken, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 404, "User B cannot delete User A document");

    // Verify document still exists for User A
    const docsA = await listDocuments(userA);
    assert(docsA.some((d) => d.id === docA.id), "Document must still exist for User A");
  });

  // ---------------------------------------------------------------------------
  // TEST 14: User B cannot read User A RAG chunks
  // ---------------------------------------------------------------------------
  await step("TEST 14: User B cannot read User A RAG chunks", async () => {
    // Search query using words from User A's private document
    const query = "Quantum flux capacitors defense matrix";
    const chunksB = await searchChunks(userB, query, 5);
    assert.equal(chunksB.length, 0, "User B must get 0 chunks from User A document");

    // User A should be able to retrieve them
    const chunksA = await searchChunks(userA, query, 5);
    assert(chunksA.length > 0, "User A must retrieve their own chunks");
  });

  // ---------------------------------------------------------------------------
  // TEST 15: Anonymous access to private tables is denied
  // ---------------------------------------------------------------------------
  await step("TEST 15: Anonymous access to private endpoints is denied", async () => {
    const endpoints = [
      { url: "/api/devices", method: "GET" },
      { url: `/api/devices/${deviceAId}/catalog`, method: "GET" },
      { url: "/api/devices/pairing/create", method: "POST" },
      { url: "/api/memories", method: "GET" },
      { url: "/api/rag/documents", method: "GET" },
      { url: "/api/settings/api-key", method: "GET" },
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${BASE_URL}${ep.url}`, {
        method: ep.method,
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 401, `Anonymous request to ${ep.url} must receive 401`);
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 16: Client-supplied userId cannot bypass ownership
  // ---------------------------------------------------------------------------
  await step("TEST 16: Client-supplied userId cannot bypass ownership", async () => {
    // 1. Send x-ultron-user-id header attempting to impersonate User A
    const memRes = await fetch(`${BASE_URL}/api/memories`, {
      method: "GET",
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${userBToken}`,
        "x-ultron-user-id": userA,
      },
    });
    assert.equal(memRes.status, 200);
    const memBody = await memRes.json();
    assert.equal(memBody.memories.some((m: any) => m.id === memoryA.id), false);

    // 2. Send body with userId: userA
    const saveRes = await authFetch("/api/memories", userBToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: userA, // Spoofed field
        category: "preference",
        key: "hacked_key",
        value: "hacked_value",
      }),
    });
    assert.equal(saveRes.status, 200);
    const saveBody = await saveRes.json();
    assert.equal(saveBody.memory.userId, userB, "Server must assign to User B, ignoring body userId");
  });

  // ---------------------------------------------------------------------------
  // TEST 17: Existing legitimate server-side operations still work
  // ---------------------------------------------------------------------------
  await step("TEST 17: Existing legitimate server-side operations still work", async () => {
    // 1. Device heartbeat using device auth token
    const heartbeat = await recordDeviceHeartbeat(deviceAToken);
    assert.notEqual(heartbeat, null, "Device heartbeat must succeed");
    assert.equal(heartbeat?.deviceId, deviceAId);
    assert.equal(heartbeat?.connectionStatus, "connected");

    // 2. Token verification
    const verified = await verifyDeviceToken(deviceAToken);
    assert.notEqual(verified, null, "Device token must verify successfully");
    assert.equal(verified?.deviceId, deviceAId);

    // 3. App catalog lookup
    const foundApp = await findInDeviceCatalog(deviceAId, "com.whatsapp");
    assert.notEqual(foundApp, null, "App catalog lookup must succeed");
    assert.equal(foundApp?.displayName, "WhatsApp");

    // 4. Server unpair device
    const unpaired = await unpairDevice(userA, deviceAId);
    assert.equal(unpaired, true, "Legitimate owner unpair must succeed");
  });

  // ---------------------------------------------------------------------------
  // TEST 18: SQL Migration file static validation (003_secure_rls.sql)
  // ---------------------------------------------------------------------------
  await step("TEST 18: Migration 003_secure_rls.sql static policy validation", async () => {
    const migrationPath = path.join(
      process.cwd(),
      "supabase",
      "migrations",
      "003_secure_rls.sql"
    );
    assert(fs.existsSync(migrationPath), "Migration 003_secure_rls.sql must exist");

    const sqlContent = fs.readFileSync(migrationPath, "utf-8");

    // 1. Tables requiring RLS enablement
    const requiredTables = [
      "public.ultron_devices",
      "public.ultron_pairing_sessions",
      "public.ultron_device_catalogs",
      "public.ultron_user_memories",
      "public.ultron_documents",
      "public.ultron_document_chunks",
    ];

    for (const table of requiredTables) {
      assert(
        sqlContent.includes(`ALTER TABLE IF EXISTS ${table} ENABLE ROW LEVEL SECURITY;`),
        `Migration must enable RLS for ${table}`
      );
    }

    // 2. Legacy insecure policies dropped
    const insecurePolicies = [
      `DROP POLICY IF EXISTS "Allow anon devices access" ON public.ultron_devices;`,
      `DROP POLICY IF EXISTS "Allow anon pairing sessions" ON public.ultron_pairing_sessions;`,
      `DROP POLICY IF EXISTS "Allow anon device catalogs" ON public.ultron_device_catalogs;`,
    ];

    for (const dropStmt of insecurePolicies) {
      assert(sqlContent.includes(dropStmt), `Migration must explicitly drop: ${dropStmt}`);
    }

    // 3. Explicit anonymous denial (USING (false))
    assert(
      (sqlContent.match(/TO anon[\s\S]*?USING \(false\);/g) || []).length >= 6,
      "All 6 private tables must deny anonymous direct access"
    );

    // 4. Explicit service_role full access
    assert(
      (sqlContent.match(/TO service_role[\s\S]*?USING \(true\)[\s\S]*?WITH CHECK \(true\);/g) || []).length >= 6,
      "All 6 private tables must allow service_role full access"
    );

    // 5. Authenticated ownership rules
    assert(
      sqlContent.includes("auth.jwt()->>'sub'") || sqlContent.includes("auth.uid()::text"),
      "Migration must check Supabase authenticated user ID"
    );

    // 6. Device catalog ownership via subquery
    assert(
      sqlContent.includes("EXISTS (") &&
      sqlContent.includes("public.ultron_devices") &&
      sqlContent.includes("d.device_id = ultron_device_catalogs.device_id"),
      "Device catalog must enforce ownership via correlated subquery to ultron_devices"
    );

    // 7. Foreign key constraint
    assert(
      sqlContent.includes("fk_ultron_device_catalogs_device"),
      "Migration must include fk_ultron_device_catalogs_device foreign key constraint"
    );
  });

  console.log("\n-------------------------------------------------------");
  console.log(`TEST RUN COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runRlsTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
