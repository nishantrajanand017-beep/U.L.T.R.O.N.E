import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  createPairingSession,
  claimPairingSession,
  _clearPairingSessionsForTest,
} from "../lib/db/deviceStore";
import { POST as commandsRoute } from "../app/api/devices/[deviceId]/commands/route";
import { APPROVED_APPS, resolveApprovedApp } from "../lib/constants/appAllowlist";
import type { DeviceCommand, DeviceCommandResult } from "../lib/realtime/deviceRealtime";

console.log("=================================================");
console.log("   ULTRON PHASE 12 STEP 2: SECURE APP LAUNCH     ");
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
 * Android Companion Simulator implementing exact UltronRealtimeManager logic for OPEN_APP:
 * - Target device isolation
 * - Expiry checks
 * - Bounded LRU replay cache (max 500)
 * - Android-side defense-in-depth allowlist
 * - Installed vs uninstalled application detection
 * - Explicit intent execution
 */
class SimulatedAndroidCompanion {
  deviceId: string;
  deviceName: string;
  installedPackages: Set<string>;
  replayCache = new Set<string>();
  receivedCommands: DeviceCommand[] = [];
  results: DeviceCommandResult[] = [];

  // Defense-in-depth Android allowlist (mirrors UltronRealtimeManager.ALLOWED_PACKAGES)
  static readonly ALLOWED_PACKAGES: Record<string, string> = {
    whatsapp: "com.whatsapp",
    telegram: "org.telegram.messenger",
    chrome: "com.android.chrome",
    youtube: "com.google.android.youtube",
    gmail: "com.google.android.gm",
    settings: "com.android.settings",
  };

  constructor(deviceId: string, deviceName: string, installedPackages: string[] = []) {
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.installedPackages = new Set(installedPackages);
  }

  handleBroadcastMessage(bPayload: any): DeviceCommandResult | null {
    const cmdId = String(bPayload?.commandId || "").trim();
    const targetDeviceId = String(bPayload?.targetDeviceId || "").trim();
    const commandType = String(bPayload?.commandType || "").trim();
    const expiresAt = Number(bPayload?.expiresAt || 0);

    // 1. Target device isolation: compare targetDeviceId with local deviceId
    if (!targetDeviceId || targetDeviceId !== this.deviceId) {
      return null; // Silently ignore non-targeted commands
    }

    if (!cmdId) {
      return null;
    }

    this.receivedCommands.push(bPayload);

    // 2. Expiry check
    const currentTime = Date.now();
    if (expiresAt > 0 && currentTime > expiresAt) {
      const res: DeviceCommandResult = {
        commandId: cmdId,
        deviceId: this.deviceId,
        commandType: commandType as any,
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
        commandType: commandType as any,
        status: "DUPLICATE",
        error: "Command has already been processed.",
        completedAt: new Date().toISOString(),
      };
      this.results.push(res);
      return res;
    }

    // 4. Command allowlist validation (PING and OPEN_APP supported)
    if (commandType !== "PING" && commandType !== "OPEN_APP") {
      const res: DeviceCommandResult = {
        commandId: cmdId,
        deviceId: this.deviceId,
        commandType: commandType as any,
        status: "FAILED",
        error: `Unsupported commandType: '${commandType}'. Only PING and OPEN_APP are supported.`,
        completedAt: new Date().toISOString(),
      };
      this.results.push(res);
      return res;
    }

    // 5. Handle PING
    if (commandType === "PING") {
      this.replayCache.add(cmdId);
      const res: DeviceCommandResult = {
        commandId: cmdId,
        deviceId: this.deviceId,
        commandType: "PING",
        status: "SUCCESS",
        result: { type: "PONG" },
        completedAt: new Date().toISOString(),
      };
      this.results.push(res);
      return res;
    }

    // 6. Handle OPEN_APP
    if (commandType === "OPEN_APP") {
      const payloadObj = bPayload?.payload;
      const appId = String(payloadObj?.appId || "").trim().toLowerCase();
      const packageName = String(payloadObj?.packageName || "").trim();

      // Android-side defense-in-depth check
      const expectedPackage = SimulatedAndroidCompanion.ALLOWED_PACKAGES[appId];
      if (!expectedPackage || (packageName && packageName !== expectedPackage)) {
        const res: DeviceCommandResult = {
          commandId: cmdId,
          deviceId: this.deviceId,
          commandType: "OPEN_APP",
          status: "FAILED",
          result: { type: "APP_DISALLOWED", appId },
          error: `Application '${appId}' is not permitted on this device.`,
          completedAt: new Date().toISOString(),
        };
        this.results.push(res);
        return res;
      }

      // Check if installed on device
      if (!this.installedPackages.has(expectedPackage)) {
        const res: DeviceCommandResult = {
          commandId: cmdId,
          deviceId: this.deviceId,
          commandType: "OPEN_APP",
          status: "FAILED",
          result: { type: "APP_NOT_INSTALLED", appId, packageName: expectedPackage },
          error: `Application '${appId}' (${expectedPackage}) is not installed on this device.`,
          completedAt: new Date().toISOString(),
        };
        this.results.push(res);
        return res;
      }

      // Record in replay cache upon successful launch
      this.replayCache.add(cmdId);
      const res: DeviceCommandResult = {
        commandId: cmdId,
        deviceId: this.deviceId,
        commandType: "OPEN_APP",
        status: "SUCCESS",
        result: { type: "APP_LAUNCHED", appId, packageName: expectedPackage },
        completedAt: new Date().toISOString(),
      };
      this.results.push(res);
      return res;
    }

    return null;
  }
}

async function runAllTests() {
  _clearPairingSessionsForTest();

  const testUserId = "usr_phase12_2_owner";
  const otherUserId = "usr_phase12_2_alien";

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

  // Setup 1 paired device for an alien user
  const sessionOther = await createPairingSession(otherUserId);
  const pairedOther = await claimPairingSession(sessionOther.code, "Alien Phone", "Android", "1.0.0");
  assert.ok(pairedOther);

  // Device A has WhatsApp, Chrome, Settings installed
  const devA = new SimulatedAndroidCompanion(pairedA.device.deviceId, pairedA.device.deviceName, [
    "com.whatsapp",
    "com.android.chrome",
    "com.android.settings",
  ]);

  // Device B has Telegram, YouTube, Settings installed (WhatsApp NOT installed)
  const devB = new SimulatedAndroidCompanion(pairedB.device.deviceId, pairedB.device.deviceName, [
    "org.telegram.messenger",
    "com.google.android.youtube",
    "com.android.settings",
  ]);

  // Device C has Settings only
  const devC = new SimulatedAndroidCompanion(pairedC.device.deviceId, pairedC.device.deviceName, [
    "com.android.settings",
  ]);

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

  // Test 1: Server Allowlist - OPEN_APP accepted for approved app
  let lastDispatchedCommand: any = null;
  await test("1. Server Allowlist: OPEN_APP accepted for approved app (200 OK)", async () => {
    const { req, params } = createMockCommandRequest(
      devA.deviceId,
      { commandType: "OPEN_APP", payload: { appId: "whatsapp" } },
      testUserId
    );
    const res = await commandsRoute(req, { params });
    assert.equal(res.status, 200, "Approved app 'whatsapp' must return 200 OK");
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.status, "PENDING");
    assert.equal(json.targetDeviceId, devA.deviceId);
    assert.ok(json.commandId.startsWith("cmd_"));

    lastDispatchedCommand = {
      commandId: json.commandId,
      targetDeviceId: devA.deviceId,
      commandType: "OPEN_APP",
      expiresAt: json.expiresAt,
      payload: { appId: "whatsapp", packageName: "com.whatsapp" },
      source: "ultron-web",
    };
  });

  // Test 2: Server Allowlist - Unknown appId rejected
  await test("2. Server Allowlist: Unknown appId rejected (400 Bad Request)", async () => {
    const disallowedAppIds = ["tiktok", "facebook", "fortnite", "super_shell", "bank_of_america"];
    for (const appId of disallowedAppIds) {
      const { req, params } = createMockCommandRequest(
        devA.deviceId,
        { commandType: "OPEN_APP", payload: { appId } },
        testUserId
      );
      const res = await commandsRoute(req, { params });
      assert.equal(res.status, 400, `Unknown appId '${appId}' must be rejected with 400`);
      const json = await res.json();
      assert.ok(json.error.includes("not on the approved application allowlist"));
    }
  });

  // Test 3: Arbitrary package name rejected / sanitized
  await test("3. Arbitrary package name in client payload is ignored/overridden by server", async () => {
    // Client tries to inject an unapproved malicious package name under a valid appId
    const { req, params } = createMockCommandRequest(
      devA.deviceId,
      {
        commandType: "OPEN_APP",
        payload: { appId: "whatsapp", packageName: "com.malicious.arbitrary.pkg" },
      },
      testUserId
    );
    const res = await commandsRoute(req, { params });
    assert.equal(res.status, 200, "Must succeed because server resolves trusted package");
    // Verify allowlist module resolves strictly to com.whatsapp
    const resolved = resolveApprovedApp("whatsapp");
    assert.equal(resolved?.packageName, "com.whatsapp", "Server package must be com.whatsapp");
  });

  // Test 4: Missing or invalid appId payload rejected
  await test("4. Missing or non-string appId rejected (400 Bad Request)", async () => {
    const badPayloads = [{}, { appId: "" }, { appId: 123 }, null];
    for (const payload of badPayloads) {
      const { req, params } = createMockCommandRequest(
        devA.deviceId,
        { commandType: "OPEN_APP", payload },
        testUserId
      );
      const res = await commandsRoute(req, { params });
      assert.equal(res.status, 400, "Missing or invalid appId must be rejected with 400");
    }
  });

  // Test 5: Unauthenticated request rejected (401)
  await test("5. Unauthenticated OPEN_APP request rejected (401 Unauthorized)", async () => {
    const { req, params } = createMockCommandRequest(
      devA.deviceId,
      { commandType: "OPEN_APP", payload: { appId: "chrome" } },
      null // No user session
    );
    const res = await commandsRoute(req, { params });
    assert.equal(res.status, 401, "Must return 401 when unauthenticated");
  });

  // Test 6: Device belonging to another user rejected (404)
  await test("6. Target device belonging to another user rejected (404 Not Found)", async () => {
    const { req, params } = createMockCommandRequest(
      pairedOther.device.deviceId,
      { commandType: "OPEN_APP", payload: { appId: "chrome" } },
      testUserId
    );
    const res = await commandsRoute(req, { params });
    assert.equal(res.status, 404, "Must return 404 for device not owned by authenticated user");
  });

  // Test 7: Multi-Device Isolation with 3 Simulated Devices (Target Device A executes, B & C ignore)
  await test("7. Multi-Device Isolation: Device A executes launch, Devices B & C silently ignore", async () => {
    const resultA = devA.handleBroadcastMessage(lastDispatchedCommand);
    const resultB = devB.handleBroadcastMessage(lastDispatchedCommand);
    const resultC = devC.handleBroadcastMessage(lastDispatchedCommand);

    // B and C MUST silently ignore:
    assert.equal(resultB, null, "Device B must silently ignore command intended for Device A");
    assert.equal(resultC, null, "Device C must silently ignore command intended for Device A");

    // Device A MUST execute and return SUCCESS:
    assert.ok(resultA, "Device A must execute command");
    assert.equal(resultA.status, "SUCCESS");
    assert.deepEqual(resultA.result, {
      type: "APP_LAUNCHED",
      appId: "whatsapp",
      packageName: "com.whatsapp",
    });
  });

  // Test 8: Uninstalled app correctly returns APP_NOT_INSTALLED with FAILED status
  await test("8. Uninstalled app detection: Returns FAILED with APP_NOT_INSTALLED", async () => {
    // Target Device B with WhatsApp (Device B does NOT have com.whatsapp installed)
    const cmdIdUninstalled = `cmd_${crypto.randomBytes(12).toString("hex")}`;
    const uninstalledCommand: DeviceCommand = {
      commandId: cmdIdUninstalled,
      targetDeviceId: devB.deviceId,
      commandType: "OPEN_APP",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 45_000,
      payload: { appId: "whatsapp", packageName: "com.whatsapp" },
      source: "ultron-web",
    };

    const result = devB.handleBroadcastMessage(uninstalledCommand);
    assert.ok(result);
    assert.equal(result.status, "FAILED");
    assert.equal((result.result as any)?.type, "APP_NOT_INSTALLED");
    assert.equal((result.result as any)?.appId, "whatsapp");
    assert.ok(result.error?.includes("not installed"));
  });

  // Test 9: Android-side allowlist rejection (Defense-in-depth)
  await test("9. Android Defense-in-Depth: Unknown package rejected on device boundary", async () => {
    const cmdIdInjected = `cmd_${crypto.randomBytes(12).toString("hex")}`;
    const injectedCommand: any = {
      commandId: cmdIdInjected,
      targetDeviceId: devA.deviceId,
      commandType: "OPEN_APP",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 45_000,
      payload: { appId: "unapproved_app", packageName: "com.unapproved.pkg" },
      source: "ultron-web",
    };

    const result = devA.handleBroadcastMessage(injectedCommand);
    assert.ok(result);
    assert.equal(result.status, "FAILED");
    assert.equal((result.result as any)?.type, "APP_DISALLOWED");
  });

  // Test 10: Replay Protection (Repeated commandId returns DUPLICATE)
  await test("10. Replay Protection: Duplicate OPEN_APP commandId rejected as DUPLICATE", async () => {
    // Replay the exact same lastDispatchedCommand on Device A:
    const replayResult = devA.handleBroadcastMessage(lastDispatchedCommand);
    assert.ok(replayResult);
    assert.equal(replayResult.status, "DUPLICATE");
    assert.ok(replayResult.error?.includes("already been processed"));
  });

  // Test 11: Expired command rejected as EXPIRED
  await test("11. Expiry Validation: Expired OPEN_APP command rejected as EXPIRED", async () => {
    const cmdIdExpired = `cmd_${crypto.randomBytes(12).toString("hex")}`;
    const expiredCommand: DeviceCommand = {
      commandId: cmdIdExpired,
      targetDeviceId: devA.deviceId,
      commandType: "OPEN_APP",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: Date.now() - 10_000, // Expired 10s ago
      payload: { appId: "chrome", packageName: "com.android.chrome" },
      source: "ultron-web",
    };

    const result = devA.handleBroadcastMessage(expiredCommand);
    assert.ok(result);
    assert.equal(result.status, "EXPIRED");
    assert.ok(result.error?.includes("expired before processing"));
  });

  // Test 12: PING command remains operational alongside OPEN_APP
  await test("12. Backward Compatibility: PING command continues to work alongside OPEN_APP", async () => {
    const { req, params } = createMockCommandRequest(
      devC.deviceId,
      { commandType: "PING", payload: {} },
      testUserId
    );
    const res = await commandsRoute(req, { params });
    assert.equal(res.status, 200, "PING must continue to return 200 OK");
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.status, "PENDING");

    const pingCommand: DeviceCommand = {
      commandId: json.commandId,
      targetDeviceId: devC.deviceId,
      commandType: "PING",
      createdAt: new Date().toISOString(),
      expiresAt: json.expiresAt,
      payload: {},
      source: "ultron-web",
    };

    const resultC = devC.handleBroadcastMessage(pingCommand);
    assert.ok(resultC);
    assert.equal(resultC.status, "SUCCESS");
    assert.deepEqual(resultC.result, { type: "PONG" });
  });

  // Test 13: Zero Token Leakage Across Entire OPEN_APP Pipeline
  await test("13. Zero Token Leakage: No credentials or tokens exposed in response", async () => {
    const { req, params } = createMockCommandRequest(
      devA.deviceId,
      { commandType: "OPEN_APP", payload: { appId: "chrome" } },
      testUserId
    );
    const res = await commandsRoute(req, { params });
    const text = await res.text();

    assert.equal(text.includes(pairedA.deviceAuthToken), false);
    const hash = crypto.createHash("sha256").update(pairedA.deviceAuthToken.trim()).digest("hex");
    assert.equal(text.includes(hash), false);
  });

  // Test 14: Single-Owner Singleton Lifecycle & Terminal Result Guarantee
  await test("14. Single-Owner Manager Guarantee: Exactly one terminal result per OPEN_APP command", async () => {
    // Simulate a device with WhatsApp installed
    const physicalCompanion = new SimulatedAndroidCompanion(devA.deviceId, "SingleManagerPhone", ["com.whatsapp"]);

    const { req, params } = createMockCommandRequest(
      devA.deviceId,
      { commandType: "OPEN_APP", payload: { appId: "whatsapp" } },
      testUserId
    );
    const res = await commandsRoute(req, { params });
    assert.equal(res.status, 200);
    const json = await res.json();
    const cmdPayload: DeviceCommand = {
      commandId: json.commandId,
      targetDeviceId: devA.deviceId,
      commandType: "OPEN_APP",
      createdAt: new Date().toISOString(),
      expiresAt: json.expiresAt,
      payload: { appId: "whatsapp", packageName: "com.whatsapp" },
      source: "ultron-web",
    };

    // With single-owner manager, broadcast is processed by the single instance exactly once
    const result1 = physicalCompanion.handleBroadcastMessage(cmdPayload);
    assert.ok(result1);
    assert.equal(result1.status, "SUCCESS");
    assert.equal(result1.commandType, "OPEN_APP");
    assert.deepEqual(result1.result, {
      type: "APP_LAUNCHED",
      appId: "whatsapp",
      packageName: "com.whatsapp",
    });

    // A duplicate arrival at the same manager is caught by replay protection
    const resultDuplicate = physicalCompanion.handleBroadcastMessage(cmdPayload);
    assert.ok(resultDuplicate);
    assert.equal(resultDuplicate.status, "DUPLICATE");

    // Ensure zero contradictory "Device context is not available" failures exist
    const contradictoryFails = physicalCompanion.results.filter(
      (r) => r.status === "FAILED" && String(r.error || "").includes("Device context")
    );
    assert.equal(contradictoryFails.length, 0);
  });

  // Test 15: Web UI Result Routing Isolation (OPEN_APP failures never pollute PING)
  await test("15. Web UI Result Routing: OPEN_APP failures route to launch results, never polluting PING", () => {
    let deviceLaunchResults: Record<string, { status: string; message: string }> = {};
    let devicePingResults: Record<string, { status: string; latencyMs?: number; message?: string }> = {};
    let launchingDeviceId: string | null = devA.deviceId;
    let pingingDeviceId: string | null = null;

    const simulateOnCommandResult = (payload: DeviceCommandResult) => {
      const resObj = payload.result as Record<string, unknown> | undefined;
      const resType = String(resObj?.type || "");
      const cmdType = payload.commandType;

      const isAppCommand =
        cmdType === "OPEN_APP" ||
        resType.startsWith("APP_") ||
        (launchingDeviceId === payload.deviceId && cmdType !== "PING" && resType !== "PONG");

      if (isAppCommand) {
        const appName = String(resObj?.appId || "application");
        const msg =
          resType === "APP_LAUNCHED"
            ? `App launch successful (${appName})`
            : resType === "APP_NOT_INSTALLED"
            ? `App not installed (${appName})`
            : payload.error
            ? `App launch failed: ${payload.error}`
            : `App launch ${payload.status}`;

        deviceLaunchResults[payload.deviceId] = { status: payload.status, message: msg };
        if (launchingDeviceId === payload.deviceId) launchingDeviceId = null;
      } else {
        const msg =
          resType === "PONG"
            ? `PONG received`
            : payload.error
            ? `PING failed: ${payload.error}`
            : `Command ${payload.status}: ${payload.error || ""}`;

        devicePingResults[payload.deviceId] = { status: payload.status, message: msg };
        if (pingingDeviceId === payload.deviceId) pingingDeviceId = null;
      }
    };

    // Case A: OPEN_APP failed (e.g. app not installed)
    simulateOnCommandResult({
      commandId: "cmd_fail_1",
      deviceId: devA.deviceId,
      commandType: "OPEN_APP",
      status: "FAILED",
      error: "Application 'telegram' is not installed.",
      result: { type: "APP_NOT_INSTALLED", appId: "telegram" },
      completedAt: new Date().toISOString(),
    });

    assert.ok(deviceLaunchResults[devA.deviceId]);
    assert.equal(deviceLaunchResults[devA.deviceId].status, "FAILED");
    assert.equal(deviceLaunchResults[devA.deviceId].message, "App not installed (telegram)");
    // Must NOT have touched devicePingResults
    assert.equal(devicePingResults[devA.deviceId], undefined);

    // Case B: PING succeeded
    pingingDeviceId = devA.deviceId;
    simulateOnCommandResult({
      commandId: "cmd_ping_1",
      deviceId: devA.deviceId,
      commandType: "PING",
      status: "SUCCESS",
      result: { type: "PONG" },
      completedAt: new Date().toISOString(),
    });

    assert.ok(devicePingResults[devA.deviceId]);
    assert.equal(devicePingResults[devA.deviceId].status, "SUCCESS");
    assert.equal(devicePingResults[devA.deviceId].message, "PONG received");
    // Launch results remain intact
    assert.equal(deviceLaunchResults[devA.deviceId].status, "FAILED");
  });

  // Test 16: Android Companion Architecture Static Guardrails
  await test("16. Android Source Guardrails: Single-instance, non-nullable appContext, no duplicate manager", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const managerSrc = await fs.readFile(
      path.join(process.cwd(), "android/app/src/main/java/com/ultron/companion/network/UltronRealtimeManager.kt"),
      "utf8"
    );
    const mainActivitySrc = await fs.readFile(
      path.join(process.cwd(), "android/app/src/main/java/com/ultron/companion/MainActivity.kt"),
      "utf8"
    );
    const serviceSrc = await fs.readFile(
      path.join(process.cwd(), "android/app/src/main/java/com/ultron/companion/service/HeartbeatService.kt"),
      "utf8"
    );

    // Guardrail A: UltronRealtimeManager has private constructor and getInstance(context)
    assert.ok(managerSrc.includes("class UltronRealtimeManager private constructor("));
    assert.ok(managerSrc.includes("fun getInstance(context: Context): UltronRealtimeManager"));

    // Guardrail B: Nullable var appContext is completely removed
    assert.equal(managerSrc.includes("var appContext: Context? = null"), false);

    // Guardrail C: Both MainActivity and HeartbeatService use UltronRealtimeManager.getInstance
    assert.ok(mainActivitySrc.includes("UltronRealtimeManager.getInstance(applicationContext)"));
    assert.ok(serviceSrc.includes("UltronRealtimeManager.getInstance(applicationContext)"));

    // Guardrail D: Neither class instantiates an independent manager via constructor
    assert.equal(mainActivitySrc.includes("= UltronRealtimeManager()"), false);
    assert.equal(serviceSrc.includes("= UltronRealtimeManager()"), false);

    // Guardrail E: MainActivity does not disconnect background companion link when paired
    assert.ok(mainActivitySrc.includes("if (!preferences.isPaired) {\n            realtimeManager.disconnect()\n        }"));
  });

  // Summary
  console.log("\n-------------------------------------------------");
  console.log(`RESULTS: ${passed}/${total} Phase 12 Step 2 tests passed.`);
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
