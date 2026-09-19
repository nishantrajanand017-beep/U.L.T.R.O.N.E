import { NextResponse } from "next/server";
import { resolveUserSession, attachSessionCookie } from "@/lib/auth/session";
import { createPairingSession } from "@/lib/db/deviceStore";

export async function POST(request: Request) {
  try {
    const { userId, isAuthenticated, isAnonymous, isNew } = await resolveUserSession(request);
    if (!userId || !isAuthenticated) {
      return NextResponse.json(
        { error: "Unauthorized: Authentication required." },
        { status: 401 }
      );
    }
    if (isAnonymous) {
      return NextResponse.json(
        { error: "Forbidden: Guest sessions cannot pair companion devices." },
        { status: 403 }
      );
    }
    const session = await createPairingSession(userId);

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
