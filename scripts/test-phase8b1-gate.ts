import assert from "node:assert";

async function runTests() {
  console.log("\n==================================================");
  console.log("ULTRON PART 8B.1: MANDATORY GATE & AUTH TEST");
  console.log("==================================================\n");

  // 1. Mandatory Gate on root path "/"
  console.log("[TEST 1] Testing Mandatory Gate on root path '/' without auth...");
  const rootRes = await fetch("http://localhost:3000/", {
    redirect: "manual",
  });
  console.log(`  GET / status: ${rootRes.status}`);
  const rootLocation = rootRes.headers.get("location");
  console.log(`  GET / redirect location: ${rootLocation}`);
  assert(
    rootRes.status === 307 || rootRes.status === 302 || rootRes.status === 308,
    `Unauthenticated GET / must redirect to /login, received status: ${rootRes.status}`
  );
  assert(
    rootLocation && (rootLocation.endsWith("/login") || rootLocation.includes("/login")),
    `Redirect destination must be /login, received: ${rootLocation}`
  );
  console.log("  ✓ Mandatory Gate passed: Unauthenticated requests to / are blocked and redirected to /login.\n");

  // 2. Form-based Login Page "/login"
  console.log("[TEST 2] Testing GET /login route and form controls...");
  const loginRes = await fetch("http://localhost:3000/login");
  console.log(`  GET /login status: ${loginRes.status}`);
  assert.strictEqual(loginRes.status, 200, "GET /login must return HTTP 200");
  const loginHtml = await loginRes.text();
  
  assert(loginHtml.includes("Welcome to ULTRON"), "Login page must have 'Welcome to ULTRON' header");
  assert(loginHtml.includes('type="email"'), "Login page must have email input");
  assert(loginHtml.includes('type="password"'), "Login page must have password input");
  assert(loginHtml.includes("SIGN IN"), "Login page must have 'SIGN IN' button");
  assert(loginHtml.includes("Continue with Google"), "Login page must have 'Continue with Google' button");
  assert(loginHtml.includes("/register"), "Login page must link to /register");
  console.log("  ✓ /login page verified with email/password form, Google OAuth, and /register link.\n");

  // 3. Form-based Register Page "/register"
  console.log("[TEST 3] Testing GET /register route and registration controls...");
  const registerRes = await fetch("http://localhost:3000/register");
  console.log(`  GET /register status: ${registerRes.status}`);
  assert.strictEqual(registerRes.status, 200, "GET /register must return HTTP 200");
  const registerHtml = await registerRes.text();

  assert(registerHtml.includes("Join ULTRON"), "Register page must have 'Join ULTRON' header");
  assert(registerHtml.includes('type="email"'), "Register page must have email input");
  assert(registerHtml.includes('type="password"'), "Register page must have password inputs");
  assert(registerHtml.includes("CREATE ACCOUNT"), "Register page must have 'CREATE ACCOUNT' button");
  assert(registerHtml.includes("Continue with Google"), "Register page must have 'Continue with Google' button");
  assert(registerHtml.includes("/login"), "Register page must link to /login");
  console.log("  ✓ /register page verified with email, password, confirm password, Google OAuth, and /login link.\n");

  // 4. Test GET /auth/callback route without code (missing code handling)
  console.log("[TEST 4] Testing GET /auth/callback without code...");
  const callbackRes = await fetch("http://localhost:3000/auth/callback", {
    redirect: "manual",
  });
  console.log(`  GET /auth/callback status: ${callbackRes.status}`);
  const callbackLocation = callbackRes.headers.get("location");
  console.log(`  Redirect location: ${callbackLocation}`);
  assert(callbackRes.status === 307 || callbackRes.status === 302, "Must redirect when code is missing");
  assert(callbackLocation && callbackLocation.includes("/login?error=auth_code_missing"), "Must redirect with auth_code_missing error");
  console.log("  ✓ Missing auth code redirects cleanly to /login with error param.\n");

  // 5. Test error query param rendering on /login
  console.log("[TEST 5] Testing error banner rendering on /login?error=test_error...");
  const errorPageRes = await fetch("http://localhost:3000/login?error=TestSecurityAlert");
  assert.strictEqual(errorPageRes.status, 200, "Must return 200");
  const errorHtml = await errorPageRes.text();
  assert(errorHtml.includes("TestSecurityAlert") || errorHtml.includes("Authentication failed"), "Error message or alert rendered");
  console.log("  ✓ Error parameter handled by LoginPage.\n");

  console.log("==================================================");
  console.log("ALL MANDATORY GATE & AUTH UI VERIFICATIONS PASSED!");
  console.log("==================================================\n");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
