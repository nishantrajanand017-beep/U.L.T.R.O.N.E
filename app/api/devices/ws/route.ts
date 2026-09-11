import { NextResponse } from "next/server";
import { getDeviceWsPort, startDeviceWebSocketServer, getActiveDeviceConnectionCount } from "@/lib/deviceWsServer";

export async function GET(request: Request) {
  try {
    const host = request.headers.get("host")?.split(":")[0] || "localhost";
    const port = getDeviceWsPort();

    // Ensure server is started in dev / standalone runtime
    try {
      startDeviceWebSocketServer(port);
    } catch {
      // already started or serverless
    }

    const wsUrl = `ws://${host}:${port}`;

    return NextResponse.json({
      success: true,
      wsUrl,
      activeConnections: getActiveDeviceConnectionCount(),
      heartbeatIntervalMs: 30000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to retrieve WebSocket status.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
