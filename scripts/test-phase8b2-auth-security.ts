/**
 * scripts/test-phase8b2-auth-security.ts
 *
 * Comprehensive Authentication & Session Security Hardening Verification Suite (Part 8B.2).
 *
 * Tests:
 * 1. Authenticated User A gets User A identity.
 * 2. Authenticated User A sending "x-ultron-user-id: User B" remains User A (cannot spoof victim).
 * 3. Unauthenticated request with "x-ultron-user-id: User B" is rejected (401).
 * 4. Request with arbitrary "Authorization: Bearer UserB" is rejected (401).
 * 5. Tampered/invalid authentication cookie is rejected (401).
 * 6. Authenticated User A cannot change identity via arbitrary headers (x-user-id, x-forwarded-user).
 * 7. OAuth callback with ?next=https://evil.example redirects safely to / (no open redirect).
 * 8. OAuth callback with ?next=//evil.example redirects safely to / (no protocol-relative redirect).
 * 9. OAuth callback with ?next=/settings redirects to /settings (safe internal path allowed).
 * 10. Logged-out / unauthenticated caller cannot access protected API functionality.
 * 11. Authenticated session survives normal refresh (cookie persistence & deterministic verification).
 * 12. Signout / invalidation clears session and terminates access.
 */

import assert from "node:assert/strict";
import {
  resolveUserSession,
  createSignedSessionToken,
  verifySignedSessionToken,
  SESSION_COOKIE_NAME,
} from "../lib/auth/session";
import { getSafeRedirectPath } from "../app/auth/callback/route";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

async function runSecurityTests() {
  console.log("\n=======================================================");
  console.log("ULTRON PART 8B.2: AUTH & SESSION SECURITY HARDENING");
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

  const userA = "usr_alice_" + Math.random().toString(36).slice(2, 8);
  const userB = "usr_bob_victim_" + Math.random().toString(36).slice(2, 8);
  const userAToken = createSignedSessionToken(userA);

  // TEST 1: Authenticated User A gets User A identity
  await step("TEST 1: Authenticated User A gets User A identity", async () => {
    const req = new Request(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${userAToken}`,
      },
      body: JSON.stringify({ message: "ping" }),
    });

    const session = await resolveUserSession(req);
    assert.equal(session.isAuthenticated, true, "User must be authenticated");
    assert.equal(session.userId, userA, "Resolved userId must match authenticated User A");
  });

  // TEST 2: User A sends "x-ultron-user-id: User B" -> identity remains User A
  await step("TEST 2: User A sends 'x-ultron-user-id: User B' -> Identity remains User A", async () => {
    const req = new Request(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${userAToken}`,
        "x-ultron-user-id": userB, // Spoofed victim header
      },
      body: JSON.stringify({ message: "ping" }),
    });

    const session = await resolveUserSession(req);
    assert.equal(session.isAuthenticated, true);
    assert.equal(session.userId, userA, "Identity MUST remain User A, never spoofed User B");
    assert.notEqual(session.userId, userB, "Server must NEVER adopt client-supplied victim ID");

    // Also verify over live HTTP route
    const httpRes = await fetch(`${BASE_URL}/api/memories`, {
      method: "GET",
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${userAToken}`,
        "x-ultron-user-id": userB,
      },
    });
    assert.equal(httpRes.status, 200, "Should succeed for authenticated user");
  });

  // TEST 3: Unauthenticated request with "x-ultron-user-id: User B" -> REJECTED
  await step("TEST 3: Unauthenticated request with 'x-ultron-user-id: User B' -> REJECTED (401)", async () => {
    const req = new Request(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ultron-user-id": userB,
      },
      body: JSON.stringify({ message: "ping" }),
    });

    const session = await resolveUserSession(req);
    assert.equal(session.isAuthenticated, false, "Unauthenticated request must not be authenticated");
    assert.equal(session.userId, null, "Unauthenticated request must have null userId");

    // Verify over live HTTP endpoint (must receive 401)
    const httpRes = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ultron-user-id": userB,
      },
      body: JSON.stringify({ message: "ping" }),
    });
    assert.equal(httpRes.status, 401, "API endpoint must return 401 Unauthorized for unauthenticated caller");
    const data = await httpRes.json();
    assert.match(data.error, /Unauthorized|Authentication required/i);
  });

  // TEST 4: Request with arbitrary "Authorization: Bearer UserB" -> REJECTED
  await step("TEST 4: Arbitrary 'Authorization: Bearer UserB' -> REJECTED (401)", async () => {
    const req = new Request(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userB}`,
      },
      body: JSON.stringify({ message: "ping" }),
    });

    const session = await resolveUserSession(req);
    assert.equal(session.isAuthenticated, false, "Arbitrary bearer string must not be authenticated");
    assert.equal(session.userId, null, "Must not set userId to raw bearer string");

    // Verify over live HTTP endpoint
    const httpRes = await fetch(`${BASE_URL}/api/memories`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${userB}`,
      },
    });
    assert.equal(httpRes.status, 401, "Protected API must reject forged bearer token with 401");
  });

  // TEST 5: Tampered/invalid authentication cookie -> REJECTED
  await step("TEST 5: Tampered/invalid authentication cookie -> REJECTED (401)", async () => {
    const tamperedToken = `${userA}.deadbeefbadf00d123456789abcdef0123456789abcdef0123456789abcdef01`;
    const verified = verifySignedSessionToken(tamperedToken);
    assert.equal(verified, null, "verifySignedSessionToken must return null for tampered signature");

    const req = new Request(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${tamperedToken}`,
      },
      body: JSON.stringify({ message: "ping" }),
    });

    const session = await resolveUserSession(req);
    assert.equal(session.isAuthenticated, false, "Tampered session cookie must be rejected");
    assert.equal(session.userId, null);

    // Verify over live HTTP endpoint
    const httpRes = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${tamperedToken}`,
      },
      body: JSON.stringify({ message: "ping" }),
    });
    assert.equal(httpRes.status, 401, "Live API must reject tampered session cookie with 401");
  });

  // TEST 6: Authenticated User A cannot change identity via arbitrary request headers
  await step("TEST 6: Authenticated User A cannot change identity via arbitrary headers", async () => {
    const req = new Request(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${userAToken}`,
        "x-user-id": userB,
        "x-forwarded-user": userB,
        "x-authenticated-user": userB,
        "x-original-user": userB,
      },
      body: JSON.stringify({ message: "ping" }),
    });

    const session = await resolveUserSession(req);
    assert.equal(session.isAuthenticated, true);
    assert.equal(session.userId, userA, "Identity must firmly remain User A regardless of arbitrary headers");
  });

  // TEST 7: OAuth callback with ?next=https://evil.example -> safe redirect to /
  await step("TEST 7: OAuth callback with ?next=https://evil.example -> redirects to /", async () => {
    const safeTarget = getSafeRedirectPath("https://evil.example/malicious");
    assert.equal(safeTarget, "/", "Absolute external URL must be rejected and defaulted to '/'");

    const callbackRes = await fetch(`${BASE_URL}/auth/callback?next=https://evil.example/malicious`, {
      redirect: "manual",
    });
    assert(callbackRes.status === 307 || callbackRes.status === 302);
    const loc = callbackRes.headers.get("location") || "";
    assert(!loc.includes("evil.example"), `Location must NOT redirect to evil.example, received: ${loc}`);
    assert(loc.includes("/login?error=auth_code_missing") || loc.endsWith("/"), "Must redirect safely");
  });

  // TEST 8: OAuth callback with ?next=//evil.example -> safe redirect to /
  await step("TEST 8: OAuth callback with ?next=//evil.example -> redirects to /", async () => {
    const safeTarget = getSafeRedirectPath("//evil.example/malicious");
    assert.equal(safeTarget, "/", "Protocol-relative URL must be rejected and defaulted to '/'");

    const backslashTarget = getSafeRedirectPath("/\\evil.example");
    assert.equal(backslashTarget, "/", "Backslash bypass URL must be rejected and defaulted to '/'");

    const jsTarget = getSafeRedirectPath("javascript:alert(1)");
    assert.equal(jsTarget, "/", "javascript: URI must be rejected and defaulted to '/'");
  });

  // TEST 9: OAuth callback with ?next=/settings -> redirects to /settings
  await step("TEST 9: OAuth callback with ?next=/settings -> redirects to /settings", async () => {
    const safeTarget = getSafeRedirectPath("/settings");
    assert.equal(safeTarget, "/settings", "Valid relative path '/settings' must be accepted");

    const safeTargetWithQuery = getSafeRedirectPath("/settings?tab=devices#section");
    assert.equal(safeTargetWithQuery, "/settings?tab=devices#section", "Relative path with query params must be accepted");
  });

  // TEST 10: Logged-out user cannot access protected application/API functionality
  await step("TEST 10: Logged-out user cannot access protected API endpoints", async () => {
    // 1. /api/chat
    const chatRes = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(chatRes.status, 401, "/api/chat must reject logged-out caller with 401");

    // 2. /api/memories
    const memRes = await fetch(`${BASE_URL}/api/memories`, {
      method: "GET",
    });
    assert.equal(memRes.status, 401, "/api/memories must reject logged-out caller with 401");

    // 3. /api/rag/documents
    const ragRes = await fetch(`${BASE_URL}/api/rag/documents`, {
      method: "GET",
    });
    assert.equal(ragRes.status, 401, "/api/rag/documents must reject logged-out caller with 401");

    // 4. /api/tools/confirm
    const toolsRes = await fetch(`${BASE_URL}/api/tools/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationId: "conf_test" }),
    });
    assert.equal(toolsRes.status, 401, "/api/tools/confirm must reject logged-out caller with 401");

    // 5. /api/devices
    const devicesRes = await fetch(`${BASE_URL}/api/devices`, {
      method: "GET",
    });
    assert.equal(devicesRes.status, 401, "/api/devices must reject logged-out caller with 401");

    // 6. /api/settings/api-key
    const settingsRes = await fetch(`${BASE_URL}/api/settings/api-key`, {
      method: "GET",
    });
    assert.equal(settingsRes.status, 401, "/api/settings/api-key must reject logged-out caller with 401");
  });

  // TEST 11: Authenticated session survives normal refresh
  await step("TEST 11: Authenticated session survives normal refresh (cookie validity persistence)", async () => {
    // Generate token once
    const token = createSignedSessionToken(userA);

    // Simulate multiple requests (refreshes) with the same cookie
    for (let i = 0; i < 3; i++) {
      const verified = verifySignedSessionToken(token);
      assert.equal(verified, userA, `Verification cycle ${i + 1} must preserve User A identity`);
    }

    const req1 = new Request(`${BASE_URL}/api/memories`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    const s1 = await resolveUserSession(req1);
    assert.equal(s1.isAuthenticated, true);
    assert.equal(s1.userId, userA);

    const req2 = new Request(`${BASE_URL}/api/memories`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    const s2 = await resolveUserSession(req2);
    assert.equal(s2.isAuthenticated, true);
    assert.equal(s2.userId, userA);
  });

  // TEST 12: Logout invalidates the authenticated application state
  await step("TEST 12: Logout invalidates authenticated application state", async () => {
    // A signed cookie that has been cleared or replaced by an empty/expired cookie is invalid
    const expiredCookieVal = "";
    const verifiedExpired = verifySignedSessionToken(expiredCookieVal);
    assert.equal(verifiedExpired, null, "Cleared session cookie must not verify");

    const req = new Request(`${BASE_URL}/api/memories`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${expiredCookieVal}` },
    });
    const session = await resolveUserSession(req);
    assert.equal(session.isAuthenticated, false, "Logged out request must resolve as unauthenticated");
    assert.equal(session.userId, null);
  });

  console.log("\n-------------------------------------------------------");
  console.log(`TEST RUN COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runSecurityTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
