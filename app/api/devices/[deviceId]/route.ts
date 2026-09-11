import { NextResponse } from "next/server";
import { resolveUserSession, attachSessionCookie } from "@/lib/auth/session";
import { unpairDevice } from "@/lib/db/deviceStore";

export async function DELETE(
  request: Request,
  props: { params: Promise<{ deviceId: string }> }
) {
  try {
    const { userId, isNew } = resolveUserSession(request);
    const { deviceId } = await props.params;

    if (!deviceId) {
      return NextResponse.json(
        { error: "Invalid request: 'deviceId' is required." },
        { status: 400 }
      );
    }

    const success = await unpairDevice(userId, deviceId);
    if (!success) {
      return NextResponse.json(
        { error: "Device not found or not authorized to unpair." },
        { status: 404 }
      );
    }

    const response = NextResponse.json({
      success: true,
      message: "Device unpaired successfully.",
      deviceId,
    });

    if (isNew) {
      attachSessionCookie(response, userId);
    }

    return response;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to unpair device.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
