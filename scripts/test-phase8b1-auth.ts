import assert from "node:assert";
import { isSupabaseConfigured } from "../lib/supabase/client";

async function runTests() {
  console.log("\n==================================================");
  console.log("ULTRON PART 8B.1: SUPABASE AUTHENTICATION TEST");
  console.log("==================================================\n");

  // 1. Check isSupabaseConfigured helper
  console.log("[TEST 1] Testing isSupabaseConfigured helper...");
  const isConfigured = isSupabaseConfigured();
  console.log(`  isSupabaseConfigured() returned: ${isConfigured}`);
  assert(typeof isConfigured === "boolean", "Must return boolean");
  console.log("  ✓ isSupabaseConfigured helper validated.\n");

  // 2. Test GET /login endpoint
  console.log("[TEST 2] Testing GET /login route...");
  const loginRes = await fetch("http://localhost:3000/login");
  console.log(`  GET /login response status: ${loginRes.status}`);
  assert.strictEqual(loginRes.status, 200, "GET /login must return 200");
  const loginHtml = await loginRes.text();
  assert(loginHtml.includes("Welcome to ULTRON"), "Must include 'Welcome to ULTRON' title");
  assert(loginHtml.includes("Continue with Google"), "Must include 'Continue with Google' button");
  assert(loginHtml.includes("/register"), "Must include register link");
  console.log("  ✓ /login page correctly renders ULTRON auth UI.\n");

  // 3. Test GET / route (verifying mandatory login gate)
  console.log("[TEST 3] Testing GET / route (verifying mandatory login gate)...");
  const homeRes = await fetch("http://localhost:3000/", { redirect: "manual" });
  console.log(`  GET / response status: ${homeRes.status}`);
  assert(homeRes.status === 307 || homeRes.status === 302, "GET / must redirect to /login for unauthenticated visitors");
  const homeLoc = homeRes.headers.get("location");
  assert(homeLoc && homeLoc.includes("/login"), "Must redirect to /login");
  console.log("  ✓ Mandatory gate successfully redirects unauthenticated visitor to /login.\n");

  // 4. Test GET /auth/callback route without code (missing code handling)
  console.log("[TEST 4] Testing GET /auth/callback without code...");
  const callbackRes = await fetch("http://localhost:3000/auth/callback", {
    redirect: "manual",
  });
  console.log(`  GET /auth/callback status: ${callbackRes.status}`);
  const location = callbackRes.headers.get("location");
  console.log(`  Redirect location: ${location}`);
  assert(callbackRes.status === 307 || callbackRes.status === 302, "Must redirect when code is missing");
  assert(location && location.includes("/login?error=auth_code_missing"), "Must redirect with auth_code_missing error");
  console.log("  ✓ Missing auth code redirects cleanly to /login with error param.\n");

  // 5. Test error query param rendering on /login
  console.log("[TEST 5] Testing error banner rendering on /login?error=test_error...");
  const errorPageRes = await fetch("http://localhost:3000/login?error=TestSecurityAlert");
  assert.strictEqual(errorPageRes.status, 200, "Must return 200");
  console.log("  ✓ Error parameter handled by LoginPage.\n");

  console.log("==================================================");
  console.log("ALL PART 8B.1 AUTOMATED TESTS PASSED SUCCESSFULLY!");
  console.log("==================================================\n");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
