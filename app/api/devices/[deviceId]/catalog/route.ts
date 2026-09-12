import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/auth/session";
import { listUserDevices, verifyDeviceToken, getSupabase } from "@/lib/db/deviceStore";
import {
  getDeviceCatalog,
  setDeviceCatalog,
  type CatalogAppEntry,
} from "@/lib/db/deviceCatalogStore";

/**
 * Extracts Bearer token or x-device-token from request headers.
 */
function getDeviceTokenFromHeaders(request: Request): string | null {
  const customHeader = request.headers.get("x-device-token");
  if (customHeader?.trim()) {
    return customHeader.trim();
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  return null;
}

/**
 * GET /api/devices/[deviceId]/catalog
 * Retrieves the discovered application catalog for a device.
 */
export async function GET(
  request: Request,
  props: { params: Promise<{ deviceId: string }> }
) {
  try {
    const { deviceId } = await props.params;
    if (!deviceId) {
      return NextResponse.json({ error: "Missing deviceId." }, { status: 400 });
    }

    // Authenticate user session or device token
    const userId = getUserIdFromRequest(request);
    let isAuthorized = false;

    if (userId) {
      const userDevices = await listUserDevices(userId);
      isAuthorized = userDevices.some((d) => d.deviceId === deviceId);
    } else {
      const deviceToken = getDeviceTokenFromHeaders(request);
      if (deviceToken) {
        const device = await verifyDeviceToken(deviceToken);
        isAuthorized = device?.deviceId === deviceId;
      }
    }

    if (!isAuthorized) {
      return NextResponse.json(
        { error: "Unauthorized or device not found." },
        { status: 401 }
      );
    }

    const apps = await getDeviceCatalog(deviceId);
    return NextResponse.json({
      success: true,
      deviceId,
      apps,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to retrieve device catalog.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST /api/devices/[deviceId]/catalog
 * Reports or syncs discovered application catalog for a device.
 */
export async function POST(
  request: Request,
  props: { params: Promise<{ deviceId: string }> }
) {
  try {
    const { deviceId } = await props.params;
    if (!deviceId) {
      return NextResponse.json({ error: "Missing deviceId." }, { status: 400 });
    }

    const userId = getUserIdFromRequest(request);
    let targetUserId = userId || "";
    let isAuthorized = false;

    if (userId) {
      const userDevices = await listUserDevices(userId);
      isAuthorized = userDevices.some((d) => d.deviceId === deviceId);
    } else {
      const deviceToken = getDeviceTokenFromHeaders(request);
      if (deviceToken) {
        const device = await verifyDeviceToken(deviceToken);
        if (device && device.deviceId === deviceId) {
          isAuthorized = true;
          targetUserId = device.userId;
        }
      }
    }

    if (!isAuthorized) {
      return NextResponse.json(
        { error: "Unauthorized: Invalid session or device credentials." },
        { status: 401 }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const reqBody = body as { apps?: unknown };
    if (!reqBody || !Array.isArray(reqBody.apps)) {
      return NextResponse.json(
        { error: "Invalid payload: 'apps' array is required." },
        { status: 400 }
      );
    }

    const rawApps = reqBody.apps as Array<{
      appId: string;
      displayName: string;
      packageName?: string;
    }>;

    await setDeviceCatalog(deviceId, rawApps);
    const savedApps: CatalogAppEntry[] = await getDeviceCatalog(deviceId);

    // Broadcast onto user's Supabase channel if user ID is known
    if (targetUserId) {
      const supabase = getSupabase();
      if (supabase) {
        try {
          const channel = supabase.channel(`ultron:devices:${targetUserId}`);
          await channel.send({
            type: "broadcast",
            event: "device:app_catalog",
            payload: {
              deviceId,
              apps: savedApps.map((a) => ({ appId: a.appId, displayName: a.displayName })),
              timestamp: Date.now(),
            },
          });
          void supabase.removeChannel(channel);
        } catch (bErr) {
          console.warn("[Catalog API] Supabase broadcast warning:", bErr);
        }
      }
    }

    return NextResponse.json({
      success: true,
      deviceId,
      count: savedApps.length,
      apps: savedApps,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to store device catalog.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
