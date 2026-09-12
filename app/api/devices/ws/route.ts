import { NextResponse } from "next/server";
import { getDeviceWsPort, startDeviceWebSocketServer, getActiveDeviceConnectionCount } from "@/lib/deviceWsServer";

export async function GET(request: Request) {
  try {
    const host = request.headers.get("host")?.split(":")[0] || "localhost";
    const port = getDeviceWsPort();

    const isLocalhost = host === "localhost" || host === "127.0.0.1";

    // Ensure server is started only in local dev standalone runtime
    if (isLocalhost) {
      try {
        startDeviceWebSocketServer(port);
      } catch {
        // already started or serverless
      }
    }

    const wsUrl = isLocalhost ? `ws://${host}:${port}` : null;

    return NextResponse.json({
      success: true,
      legacy: true,
      wsUrl,
      realtimeEndpoint: "/api/devices/realtime",
      activeConnections: getActiveDeviceConnectionCount(),
      heartbeatIntervalMs: 30000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to retrieve WebSocket status.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
