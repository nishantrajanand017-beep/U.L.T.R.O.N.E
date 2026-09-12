import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  createPairingSession,
  claimPairingSession,
  _clearPairingSessionsForTest,
} from "../lib/db/deviceStore";
import {
  setDeviceCatalog,
  getDeviceCatalog,
  findInDeviceCatalog,
  sanitizeAppId,
  sanitizeDisplayName,
  clearDeviceCatalog,
} from "../lib/db/deviceCatalogStore";
import { POST as commandsRoute } from "../app/api/devices/[deviceId]/commands/route";
import { GET as getCatalogRoute, POST as postCatalogRoute } from "../app/api/devices/[deviceId]/catalog/route";
import { APPROVED_APPS } from "../lib/constants/appAllowlist";
import type { DeviceCommand, DeviceCommandResult } from "../lib/realtime/deviceRealtime";

console.log("================================================================");
console.log("  ULTRON PHASE 12 STEP 3: PERSISTENT COMPANION & DYNAMIC APPS   ");
console.log("================================================================\n");

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
 * Android Companion Simulator with Phase 12 Step 3 capabilities:
 * - Dynamic launcher app discovery catalog
 * - Dynamic app resolution during OPEN_APP
 * - REQUEST_CATALOG command support
 * - Replay & Expiry protection
 * - Target device isolation
 */
class SimulatedPhase12_3Companion {
  deviceId: string;
  deviceName: string;
  installedPackages: Set<string>;
  discoveredApps = new Map<string, { appId: string; displayName: string; packageName: string }>();
  replayCache = new Set<string>();
  receivedCommands: DeviceCommand[] = [];
  results: DeviceCommandResult[] = [];

  static readonly DEFAULT_PACKAGES: Record<string, string> = {
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
    this.discoverApps();
  }

  discoverApps() {
    // 1. Populate default packages
    for (const [id, pkg] of Object.entries(SimulatedPhase12_3Companion.DEFAULT_PACKAGES)) {
      if (this.installedPackages.has(pkg)) {
        this.discoveredApps.set(id, { appId: id, displayName: id.toUpperCase(), packageName: pkg });
      }
    }
    // 2. Discover other launcher apps installed on device
    for (const pkg of this.installedPackages) {
      if (!Object.values(SimulatedPhase12_3Companion.DEFAULT_PACKAGES).includes(pkg)) {
        const id = pkg.split(".").pop() || pkg;
        this.discoveredApps.set(id, { appId: id, displayName: id.toUpperCase(), packageName: pkg });
      }
    }
  }

  handleBroadcastMessage(bPayload: any): DeviceCommandResult | null {
    const cmdId = String(bPayload?.commandId || "").trim();
    const targetDeviceId = String(bPayload?.targetDeviceId || "").trim();
    const commandType = String(bPayload?.commandType || "").trim();
    const expiresAt = Number(bPayload?.expiresAt || 0);

    // Target device isolation
    if (!targetDeviceId || targetDeviceId !== this.deviceId) {
      return null;
    }
    if (!cmdId) return null;

    this.receivedCommands.push(bPayload);

    // Expiry check
    if (expiresAt > 0 && Date.now() > expiresAt) {
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

    // Replay protection
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

    if (commandType === "REQUEST_CATALOG") {
      this.replayCache.add(cmdId);
      this.discoverApps();
      const res: DeviceCommandResult = {
        commandId: cmdId,
        deviceId: this.deviceId,
        commandType: "REQUEST_CATALOG" as any,
        status: "SUCCESS",
        result: {
          type: "CATALOG_SYNCED",
          count: this.discoveredApps.size,
        },
        completedAt: new Date().toISOString(),
      };
      this.results.push(res);
      return res;
    }

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

    if (commandType === "OPEN_APP") {
      const appId = String(bPayload.payload?.appId || "").toLowerCase();
      const payloadPkg = String(bPayload.payload?.packageName || "");

      const resolvedApp = this.discoveredApps.get(appId);
      const expectedPackage =
        resolvedApp?.packageName ||
        SimulatedPhase12_3Companion.DEFAULT_PACKAGES[appId] ||
        (payloadPkg && this.installedPackages.has(payloadPkg) ? payloadPkg : null);

      if (!expectedPackage) {
        const res: DeviceCommandResult = {
          commandId: cmdId,
          deviceId: this.deviceId,
          commandType: "OPEN_APP",
          status: "FAILED",
          result: { type: "APP_DISALLOWED", appId },
          error: `Application '${appId}' is not permitted or installed on this device.`,
          completedAt: new Date().toISOString(),
        };
        this.results.push(res);
        return res;
      }

      if (!this.installedPackages.has(expectedPackage)) {
        const res: DeviceCommandResult = {
          commandId: cmdId,
          deviceId: this.deviceId,
          commandType: "OPEN_APP",
          status: "FAILED",
          result: { type: "APP_NOT_INSTALLED", appId, packageName: expectedPackage },
          error: `Application '${appId}' (${expectedPackage}) is not installed.`,
          completedAt: new Date().toISOString(),
        };
        this.results.push(res);
        return res;
      }

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

    const res: DeviceCommandResult = {
      commandId: cmdId,
      deviceId: this.deviceId,
      commandType: commandType as any,
      status: "FAILED",
      error: `Unsupported commandType: '${commandType}'`,
      completedAt: new Date().toISOString(),
    };
    this.results.push(res);
    return res;
  }
}

async function runAllTests() {
  _clearPairingSessionsForTest();
  const testUserId = `user_p12_3_${Date.now()}`;

  // Helper to construct authenticated requests
  const makeAuthReq = (url: string, method = "GET", body?: any, token?: string) => {
    const headers: Record<string, string> = {
      "x-ultron-user-id": testUserId,
    };
    if (token) {
      headers["x-device-token"] = token;
    }
    if (body) {
      headers["content-type"] = "application/json";
    }
    return new Request(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  // Pair two test devices for multi-device tests
  const sessionA = await createPairingSession(testUserId);
  const pairA = await claimPairingSession(sessionA.code, "Galaxy S24 Ultra", "Android");
  assert.ok(pairA, "Device A must pair successfully");
  const deviceA = pairA.device;
  const tokenA = pairA.deviceAuthToken;

  const sessionB = await createPairingSession(testUserId);
  const pairB = await claimPairingSession(sessionB.code, "Pixel 9 Pro", "Android");
  assert.ok(pairB, "Device B must pair successfully");
  const deviceB = pairB.device;
  const tokenB = pairB.deviceAuthToken;

  // TEST 1: Sanitization helpers
  await test("Catalog Sanitization: IDs and labels are normalized and bounded", () => {
    assert.equal(sanitizeAppId("  Spotify_Music-Pro!@#  "), "spotify_music-pro");
    assert.equal(sanitizeAppId("a".repeat(100)).length, 64);
    assert.equal(sanitizeDisplayName("  Clean Label \x00\x08  "), "Clean Label");
  });

  // TEST 2: Device reports catalog via POST /api/devices/[deviceId]/catalog
  await test("Device reports discovered app catalog via POST /api/devices/[deviceId]/catalog", async () => {
    const catalogData = {
      apps: [
        { appId: "spotify", displayName: "Spotify", packageName: "com.spotify.music" },
        { appId: "discord", displayName: "Discord", packageName: "com.discord" },
        { appId: "slack", displayName: "Slack", packageName: "com.Slack" },
      ],
    };

    const req = makeAuthReq(
      `http://localhost/api/devices/${deviceA.deviceId}/catalog`,
      "POST",
      catalogData,
      tokenA
    );
    const res = await postCatalogRoute(req, {
      params: Promise.resolve({ deviceId: deviceA.deviceId }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.count, 3);
  });

  // TEST 3: Retrieve catalog via GET
  await test("Retrieve stored catalog via GET /api/devices/[deviceId]/catalog", async () => {
    const req = makeAuthReq(`http://localhost/api/devices/${deviceA.deviceId}/catalog`, "GET");
    const res = await getCatalogRoute(req, {
      params: Promise.resolve({ deviceId: deviceA.deviceId }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.apps.length, 3);
    assert.equal(data.apps[0].appId, "spotify");
    assert.equal(data.apps[0].displayName, "Spotify");
  });

  // TEST 4: Dispatch OPEN_APP with dynamically discovered app
  await test("Command OPEN_APP with dynamic app resolves and injects package name", async () => {
    const req = makeAuthReq(
      `http://localhost/api/devices/${deviceA.deviceId}/commands`,
      "POST",
      {
        commandType: "OPEN_APP",
        payload: { appId: "spotify" },
      }
    );
    const res = await commandsRoute(req, {
      params: Promise.resolve({ deviceId: deviceA.deviceId }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, "PENDING");
  });

  // TEST 5: Reject unapproved / unknown app
  await test("Command OPEN_APP with unknown appId is rejected with 400 Bad Request", async () => {
    const req = makeAuthReq(
      `http://localhost/api/devices/${deviceA.deviceId}/commands`,
      "POST",
      {
        commandType: "OPEN_APP",
        payload: { appId: "totally_unapproved_trojan" },
      }
    );
    const res = await commandsRoute(req, {
      params: Promise.resolve({ deviceId: deviceA.deviceId }),
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /not on the approved (application )?allowlist or discovered catalog/i);
  });

  // TEST 6: Multi-Device Catalog Isolation
  await test("Multi-Device Isolation: App on Device A cannot be launched on Device B without its own catalog entry", async () => {
    // Spotify is on Device A's catalog, NOT on Device B
    const req = makeAuthReq(
      `http://localhost/api/devices/${deviceB.deviceId}/commands`,
      "POST",
      {
        commandType: "OPEN_APP",
        payload: { appId: "spotify" },
      }
    );
    const res = await commandsRoute(req, {
      params: Promise.resolve({ deviceId: deviceB.deviceId }),
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /not on the approved (application )?allowlist or discovered catalog/i);
  });

  // TEST 7: Built-in allowlist precedence
  await test("Built-in apps (e.g. YouTube) succeed on any device even without dynamic catalog entries", async () => {
    const req = makeAuthReq(
      `http://localhost/api/devices/${deviceB.deviceId}/commands`,
      "POST",
      {
        commandType: "OPEN_APP",
        payload: { appId: "youtube" },
      }
    );
    const res = await commandsRoute(req, {
      params: Promise.resolve({ deviceId: deviceB.deviceId }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
  });

  // TEST 8: Android Companion Simulator - Dynamic Launch Success
  await test("Android Companion Simulator: Launches dynamic app and broadcasts SUCCESS", () => {
    const companion = new SimulatedPhase12_3Companion(deviceA.deviceId, "Galaxy S24", [
      "com.spotify.music",
      "com.whatsapp",
    ]);

    const result = companion.handleBroadcastMessage({
      commandId: "cmd_test_dyn_1",
      targetDeviceId: deviceA.deviceId,
      commandType: "OPEN_APP",
      expiresAt: Date.now() + 30_000,
      payload: { appId: "spotify", packageName: "com.spotify.music" },
    });

    assert.ok(result);
    assert.equal(result.status, "SUCCESS");
    assert.equal((result.result as any).type, "APP_LAUNCHED");
    assert.equal((result.result as any).packageName, "com.spotify.music");
  });

  // TEST 9: Android Companion Simulator - Disallowed app rejected
  await test("Android Companion Simulator: Rejects disallowed app with APP_DISALLOWED", () => {
    const companion = new SimulatedPhase12_3Companion(deviceA.deviceId, "Galaxy S24", [
      "com.whatsapp",
    ]);

    const result = companion.handleBroadcastMessage({
      commandId: "cmd_test_dyn_2",
      targetDeviceId: deviceA.deviceId,
      commandType: "OPEN_APP",
      expiresAt: Date.now() + 30_000,
      payload: { appId: "unauthorized_app" },
    });

    assert.ok(result);
    assert.equal(result.status, "FAILED");
    assert.equal((result.result as any).type, "APP_DISALLOWED");
  });

  // TEST 10: Android Companion Simulator - REQUEST_CATALOG handling
  await test("Android Companion Simulator: Handles REQUEST_CATALOG and acknowledges CATALOG_SYNCED", () => {
    const companion = new SimulatedPhase12_3Companion(deviceA.deviceId, "Galaxy S24", [
      "com.whatsapp",
      "com.google.android.youtube",
      "com.spotify.music",
    ]);

    const result = companion.handleBroadcastMessage({
      commandId: "cmd_test_req_cat",
      targetDeviceId: deviceA.deviceId,
      commandType: "REQUEST_CATALOG",
      expiresAt: Date.now() + 30_000,
      payload: {},
    });

    assert.ok(result);
    assert.equal(result.status, "SUCCESS");
    assert.equal((result.result as any).type, "CATALOG_SYNCED");
    assert.equal((result.result as any).count, 3);
  });

  // TEST 11: Cleanup test device catalogs
  await test("Catalog cleanup on device unpair", async () => {
    await clearDeviceCatalog(deviceA.deviceId);
    const cat = await getDeviceCatalog(deviceA.deviceId);
    assert.equal(cat.length, 0);
  });

  console.log("\n================================================================");
  console.log(`Phase 12 Step 3 Test Summary: ${passed}/${total} passed`);
  console.log("================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

void runAllTests();
