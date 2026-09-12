import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/auth/session";
import { listUserDevices, getSupabase } from "@/lib/db/deviceStore";
import type { DeviceCommand } from "@/lib/realtime/deviceRealtime";

export async function POST(
  request: Request,
  props: { params: Promise<{ deviceId: string }> }
) {
  try {
    // 1. Authenticate user session
    const userId = getUserIdFromRequest(request);
    if (!userId) {
      return NextResponse.json(
        { error: "Unauthorized: Missing or invalid user session." },
        { status: 401 }
      );
    }

    const { deviceId } = await props.params;
    if (!deviceId) {
      return NextResponse.json(
        { error: "Invalid request: 'deviceId' parameter is required." },
        { status: 400 }
      );
    }

    // 2. Verify device ownership (must belong to authenticated user)
    const devices = await listUserDevices(userId);
    const targetDevice = devices.find((d) => d.deviceId === deviceId);
    if (!targetDevice) {
      return NextResponse.json(
        { error: "Device not found or not registered to the authenticated user." },
        { status: 404 }
      );
    }

    // 3. Validate request JSON and allowlisted commandType
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body in request." },
        { status: 400 }
      );
    }

    const reqBody = body as { commandType?: unknown; payload?: unknown };
    if (!reqBody || typeof reqBody !== "object") {
      return NextResponse.json(
        { error: "Invalid request body." },
        { status: 400 }
      );
    }

    if (reqBody.commandType !== "PING") {
      return NextResponse.json(
        {
          error: `Unsupported commandType: "${String(reqBody.commandType)}". Only "PING" is supported in Phase 12 Step 1.`,
        },
        { status: 400 }
      );
    }

    // 4. Generate command ID and timestamps (45s TTL)
    const now = Date.now();
    const expiresAt = now + 45_000;
    const commandId = `cmd_${crypto.randomBytes(12).toString("hex")}`;
    const createdAt = new Date(now).toISOString();

    const command: DeviceCommand = {
      commandId,
      targetDeviceId: deviceId,
      commandType: "PING",
      createdAt,
      expiresAt,
      payload: (reqBody.payload && typeof reqBody.payload === "object" ? reqBody.payload : {}) as Record<string, unknown>,
      source: "ultron-web",
    };

    // 5. Broadcast command onto user-scoped Supabase Realtime channel
    const supabase = getSupabase();
    if (supabase) {
      try {
        const channel = supabase.channel(`ultron:devices:${userId}`);
        await channel.send({
          type: "broadcast",
          event: "device_command",
          payload: command,
        });
        void supabase.removeChannel(channel);
      } catch (err) {
        console.warn("[Device Commands API] Supabase broadcast warning:", err);
      }
    }

    // 6. Return standard 200 OK response with zero sensitive data
    return NextResponse.json({
      success: true,
      commandId,
      status: "PENDING",
      targetDeviceId: deviceId,
      expiresAt,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to dispatch device command.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
