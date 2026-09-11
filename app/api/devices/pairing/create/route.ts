import { NextResponse } from "next/server";
import { resolveUserSession, attachSessionCookie } from "@/lib/auth/session";
import { createPairingSession } from "@/lib/db/deviceStore";

export async function POST(request: Request) {
  try {
    const { userId, isNew } = resolveUserSession(request);
    const session = createPairingSession(userId);

    const response = NextResponse.json({
      success: true,
      code: session.code,
      expiresAt: session.expiresAt,
      expiresInSeconds: session.expiresInSeconds,
    });

    if (isNew) {
      attachSessionCookie(response, userId);
    }

    return response;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to create pairing session.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
