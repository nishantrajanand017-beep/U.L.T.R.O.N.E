/**
 * scripts/test-guest-flow.ts
 *
 * Automated verification suite for the ULTRON "Continue as Guest" feature.
 * Validates:
 * 1. Session resolution handles anonymous/guest markers correctly.
 * 2. Strict backend permission enforcement (403 Forbidden) on:
 *    - /api/memories (GET, POST, DELETE)
 *    - /api/rag/documents (GET, POST, DELETE)
 *    - /api/devices (GET)
 *    - /api/devices/pairing/create (POST)
 *    - /api/devices/[deviceId] (DELETE)
 *    - /api/settings/api-key (GET, POST, DELETE)
 * 3. Tool execution safety (device tools denied for guest, safe time tool allowed).
 * 4. Permanent user regression checks.
 */

import assert from "node:assert/strict";
import {
  resolveUserSession,
  createSignedSessionToken,
  SESSION_COOKIE_NAME,
} from "../lib/auth/session";
import { executeTool } from "../lib/tools/executor";
import { GET as getMemories, POST as postMemories, DELETE as deleteMemories } from "../app/api/memories/route";
import { GET as getRag, POST as postRag, DELETE as deleteRag } from "../app/api/rag/documents/route";
import { GET as getDevices } from "../app/api/devices/route";
import { POST as postPairingCreate } from "../app/api/devices/pairing/create/route";
import { DELETE as deleteDevice } from "../app/api/devices/[deviceId]/route";
import { GET as getApiKey, POST as postApiKey, DELETE as deleteApiKey } from "../app/api/settings/api-key/route";
import type { NextRequest } from "next/server";

async function runTests() {
  console.log("\n========================================================");
  console.log("  ULTRON CONTINUED AS GUEST SECURITY VERIFICATION");
  console.log("========================================================\n");

  let passed = 0;
  let failed = 0;

  function record(testName: string, ok: boolean, details?: string) {
    if (ok) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName}: ${details}`);
      failed++;
    }
  }

  // --- TEST 1: Tool Execution Context Boundaries ---
  console.log("[1] Tool Execution Boundary Tests:");
  {
    const deviceStatusTool = {
      id: "call_1",
      type: "function" as const,
      function: {
        name: "get_device_status",
        arguments: JSON.stringify({ deviceId: "dev_mock_123" }),
      },
    };

    const guestContext = {
      userId: "guest_usr_test_123",
      isAnonymous: true,
    };

    const statusResult = await executeTool(deviceStatusTool, guestContext);
    record(
      "Guest cannot execute get_device_status",
      statusResult.status === "error" &&
        (statusResult.error?.includes("Guest operators cannot interact") || false)
    );

    const openAppTool = {
      id: "call_2",
      type: "function" as const,
      function: {
        name: "open_device_app",
        arguments: JSON.stringify({ deviceId: "dev_mock_123", appId: "whatsapp" }),
      },
    };

    const appResult = await executeTool(openAppTool, guestContext);
    record(
      "Guest cannot execute open_device_app",
      appResult.status === "error" &&
        (appResult.error?.includes("Guest operators cannot interact") || false)
    );

    const timeTool = {
      id: "call_3",
      type: "function" as const,
      function: {
        name: "get_system_time",
        arguments: "{}",
      },
    };

    const timeResult = await executeTool(timeTool, guestContext);
    record(
      "Guest can execute safe get_system_time tool",
      timeResult.status === "success"
    );
  }

  // --- TEST 2: Session Resolution Tests ---
  console.log("\n[2] Session Resolution Tests:");
  const guestUserId = "guest_operator_" + Math.random().toString(36).slice(2, 8);
  const guestToken = createSignedSessionToken(guestUserId);
  const guestCookieHeader = `${SESSION_COOKIE_NAME}=${guestToken}`;

  const permUserId = "usr_alice_" + Math.random().toString(36).slice(2, 8);
  const permToken = createSignedSessionToken(permUserId);
  const permCookieHeader = `${SESSION_COOKIE_NAME}=${permToken}`;

  {
    const guestReq = new Request("http://localhost:3000/api/chat", {
      headers: { cookie: guestCookieHeader },
    });
    const guestSession = await resolveUserSession(guestReq);
    record(
      "resolveUserSession flags guest_ prefix token as isAnonymous: true",
      guestSession.isAuthenticated === true &&
        guestSession.isAnonymous === true &&
        guestSession.userId === guestUserId
    );

    const permReq = new Request("http://localhost:3000/api/chat", {
      headers: { cookie: permCookieHeader },
    });
    const permSession = await resolveUserSession(permReq);
    record(
      "resolveUserSession flags normal token as isAnonymous: false",
      permSession.isAuthenticated === true &&
        permSession.isAnonymous === false &&
        permSession.userId === permUserId
    );
  }

  // --- TEST 3: API Endpoint 403 Forbidden Enforcement Tests ---
  console.log("\n[3] API Endpoint 403 Forbidden Enforcement Tests for Guest:");
  {
    // 3a. /api/memories
    const reqMemGet = new Request("http://localhost:3000/api/memories", {
      headers: { cookie: guestCookieHeader },
    });
    const resMemGet = await getMemories(reqMemGet);
    record(
      "GET /api/memories returns 403 for guest",
      resMemGet.status === 403
    );

    const reqMemPost = new Request("http://localhost:3000/api/memories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: guestCookieHeader,
      },
      body: JSON.stringify({ category: "preference", key: "theme", value: "dark" }),
    });
    const resMemPost = await postMemories(reqMemPost);
    record(
      "POST /api/memories returns 403 for guest",
      resMemPost.status === 403
    );

    const reqMemDel = new Request("http://localhost:3000/api/memories?id=123", {
      method: "DELETE",
      headers: { cookie: guestCookieHeader },
    });
    const resMemDel = await deleteMemories(reqMemDel);
    record(
      "DELETE /api/memories returns 403 for guest",
      resMemDel.status === 403
    );

    // 3b. /api/rag/documents
    const reqRagGet = new Request("http://localhost:3000/api/rag/documents", {
      headers: { cookie: guestCookieHeader },
    }) as NextRequest;
    const resRagGet = await getRag(reqRagGet);
    record(
      "GET /api/rag/documents returns 403 for guest",
      resRagGet.status === 403
    );

    const reqRagPost = new Request("http://localhost:3000/api/rag/documents", {
      method: "POST",
      headers: { cookie: guestCookieHeader },
    }) as NextRequest;
    const resRagPost = await postRag(reqRagPost);
    record(
      "POST /api/rag/documents returns 403 for guest",
      resRagPost.status === 403
    );

    const reqRagDel = new Request("http://localhost:3000/api/rag/documents?id=doc123", {
      method: "DELETE",
      headers: { cookie: guestCookieHeader },
    }) as unknown as NextRequest;
    (reqRagDel as any).nextUrl = new URL("http://localhost:3000/api/rag/documents?id=doc123");
    const resRagDel = await deleteRag(reqRagDel);
    record(
      "DELETE /api/rag/documents returns 403 for guest",
      resRagDel.status === 403
    );

    // 3c. /api/devices
    const reqDevGet = new Request("http://localhost:3000/api/devices", {
      headers: { cookie: guestCookieHeader },
    });
    const resDevGet = await getDevices(reqDevGet);
    record(
      "GET /api/devices returns 403 for guest",
      resDevGet.status === 403
    );

    // 3d. /api/devices/pairing/create
    const reqPairPost = new Request("http://localhost:3000/api/devices/pairing/create", {
      method: "POST",
      headers: { cookie: guestCookieHeader },
    });
    const resPairPost = await postPairingCreate(reqPairPost);
    record(
      "POST /api/devices/pairing/create returns 403 for guest",
      resPairPost.status === 403
    );

    // 3e. /api/devices/[deviceId]
    const reqDevDel = new Request("http://localhost:3000/api/devices/dev_123", {
      method: "DELETE",
      headers: { cookie: guestCookieHeader },
    });
    const resDevDel = await deleteDevice(reqDevDel, {
      params: Promise.resolve({ deviceId: "dev_123" }),
    });
    record(
      "DELETE /api/devices/[deviceId] returns 403 for guest",
      resDevDel.status === 403
    );

    // 3f. /api/settings/api-key
    const reqKeyGet = new Request("http://localhost:3000/api/settings/api-key", {
      headers: { cookie: guestCookieHeader },
    });
    const resKeyGet = await getApiKey(reqKeyGet);
    record(
      "GET /api/settings/api-key returns 403 for guest",
      resKeyGet.status === 403
    );

    const reqKeyPost = new Request("http://localhost:3000/api/settings/api-key", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: guestCookieHeader,
      },
      body: JSON.stringify({ apiKey: "AIzaSyFakeKey123" }),
    });
    const resKeyPost = await postApiKey(reqKeyPost);
    record(
      "POST /api/settings/api-key returns 403 for guest",
      resKeyPost.status === 403
    );

    const reqKeyDel = new Request("http://localhost:3000/api/settings/api-key", {
      method: "DELETE",
      headers: { cookie: guestCookieHeader },
    });
    const resKeyDel = await deleteApiKey(reqKeyDel);
    record(
      "DELETE /api/settings/api-key returns 403 for guest",
      resKeyDel.status === 403
    );
  }

  // --- TEST 4: Authenticated (Non-Guest) Behavior Unaffected ---
  console.log("\n[4] Authenticated (Permanent User) Non-Regression Tests:");
  {
    const authContext = {
      userId: permUserId,
      isAnonymous: false,
    };

    const timeResult = await executeTool(
      {
        id: "call_perm",
        type: "function" as const,
        function: { name: "get_system_time", arguments: "{}" },
      },
      authContext
    );
    record(
      "Permanent user can execute get_system_time without restriction",
      timeResult.status === "success"
    );
  }

  console.log("\n========================================================");
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("========================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
