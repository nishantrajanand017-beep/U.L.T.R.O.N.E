import { NextResponse } from "next/server";
import { claimPairingSession } from "@/lib/db/deviceStore";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.pairingCode !== "string" || !body.pairingCode.trim()) {
      return NextResponse.json(
        { error: "Invalid request: 'pairingCode' is required." },
        { status: 400 }
      );
    }

    const pairingCode = body.pairingCode.trim();
    const deviceName = typeof body.deviceName === "string" ? body.deviceName.trim() : "Android Device";
    const platform = typeof body.platform === "string" ? body.platform.trim() : "Android";
    const appVersion = typeof body.appVersion === "string" ? body.appVersion.trim() : "1.0.0";

    const result = await claimPairingSession(pairingCode, deviceName, platform, appVersion);

    return NextResponse.json({
      success: true,
      deviceId: result.device.deviceId,
      deviceAuthToken: result.deviceAuthToken,
      deviceName: result.device.deviceName,
      userId: result.device.userId,
      pairedAt: result.device.pairedAt,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Pairing failed.";

    if (msg.includes("Invalid or unknown")) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg.includes("expired")) {
      return NextResponse.json({ error: msg }, { status: 410 });
    }
    if (msg.includes("already been used")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
