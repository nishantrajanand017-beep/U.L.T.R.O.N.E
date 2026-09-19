import { NextResponse } from "next/server";
import { verifyDeviceToken } from "@/lib/db/deviceStore";
import { getDeviceWsPort } from "@/lib/deviceWsServer";

export async function GET(request: Request) {
  try {
    // 1. Authenticate device via Bearer token
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized: Missing or malformed device token." },
        { status: 401 }
      );
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return NextResponse.json(
        { error: "Unauthorized: Empty device token." },
        { status: 401 }
      );
    }

    const device = await verifyDeviceToken(token);
    if (!device) {
      return NextResponse.json(
        { error: "Unauthorized: Invalid or revoked device token." },
        { status: 401 }
      );
    }

    // 2. Resolve Supabase Realtime configuration
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
    const supabaseAnonKey = (
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      ""
    ).trim();

    const isSupabaseConfigured =
      Boolean(supabaseUrl && supabaseAnonKey) &&
      !supabaseUrl.includes("your_supabase");

    const channel = `ultron:devices:${device.userId}`;
    const phoenixTopic = `realtime:ultron:devices:${device.userId}`;

    let realtimeWsUrl = "";
    if (isSupabaseConfigured) {
      try {
        const parsed = new URL(supabaseUrl);
        const host = parsed.host;
        realtimeWsUrl = `wss://${host}/realtime/v1/websocket?apikey=${encodeURIComponent(supabaseAnonKey)}&vsn=1.0.0`;
      } catch {
        // malformed supabase url
      }
    }

    // Fallback legacy development ws url (localhost only)
    const host = request.headers.get("host")?.split(":")[0] || "localhost";
    const devWsPort = getDeviceWsPort();
    const isLocalhost = host === "localhost" || host === "127.0.0.1";
    const legacyWsUrl = isLocalhost ? `ws://${host}:${devWsPort}` : "";

    return NextResponse.json({
      success: true,
      configured: isSupabaseConfigured,
      provider: isSupabaseConfigured ? "supabase" : "legacy_ws",
      channel,
      phoenixTopic,
      private: true,
      realtimeWsUrl: isSupabaseConfigured ? realtimeWsUrl : legacyWsUrl,
      supabaseUrl: isSupabaseConfigured ? supabaseUrl : undefined,
      supabaseAnonKey: isSupabaseConfigured ? supabaseAnonKey : undefined,
      legacyWsUrl: isLocalhost ? legacyWsUrl : undefined,
      deviceId: device.deviceId,
      userId: device.userId,
      heartbeatIntervalMs: 25000,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Failed to provision realtime session.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
