import { NextResponse } from "next/server";
import { resolveUserSession, attachSessionCookie } from "@/lib/auth/session";
import { listUserDevices } from "@/lib/db/deviceStore";

export async function GET(request: Request) {
  try {
    const { userId, isAuthenticated, isNew } = await resolveUserSession(request);
    if (!userId || !isAuthenticated) {
      return NextResponse.json(
        { error: "Unauthorized: Authentication required." },
        { status: 401 }
      );
    }
    const devices = await listUserDevices(userId);

    const response = NextResponse.json({
      success: true,
      userId,
      devices,
    });

    if (isNew) {
      attachSessionCookie(response, userId);
    }

    return response;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to list devices.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
