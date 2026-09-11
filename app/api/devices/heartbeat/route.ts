import { NextResponse } from "next/server";
import { recordDeviceHeartbeat } from "@/lib/db/deviceStore";

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get("authorization") || "";
    let token = "";

    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    } else {
      token = (request.headers.get("x-ultron-device-token") || "").trim();
    }

    if (!token) {
      return NextResponse.json(
        { error: "Unauthorized: Missing device authentication token." },
        { status: 401 }
      );
    }

    const device = await recordDeviceHeartbeat(token);
    if (!device) {
      return NextResponse.json(
        { error: "Unauthorized: Invalid or revoked device token." },
        { status: 401 }
      );
    }

    return NextResponse.json({
      success: true,
      connectionStatus: device.connectionStatus,
      lastSeenAt: device.lastSeenAt,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Heartbeat failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
