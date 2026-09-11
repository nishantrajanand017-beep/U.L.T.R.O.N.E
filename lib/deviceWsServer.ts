import { WebSocketServer, WebSocket } from "ws";
import {
  verifyDeviceToken,
  recordDeviceHeartbeat,
  setDeviceConnectionStatus,
  type SanitizedDevice,
} from "./db/deviceStore";

interface ConnectedClient {
  ws: WebSocket;
  device: SanitizedDevice;
  token: string;
  isAlive: boolean;
}

let wssInstance: WebSocketServer | null = null;
const activeClients = new Map<string, ConnectedClient>(); // keyed by deviceId

export function getDeviceWsPort(): number {
  const envPort = process.env.DEVICE_WS_PORT;
  if (envPort && !isNaN(Number(envPort))) {
    return Number(envPort);
  }
  return 3001;
}

/**
 * Initializes the standalone WebSocket server for Android device companion connections.
 */
export function startDeviceWebSocketServer(port = getDeviceWsPort()): WebSocketServer {
  if (wssInstance) {
    return wssInstance;
  }

  const wss = new WebSocketServer({ port });
  wssInstance = wss;

  console.log(`[ULTRON WS] Android Device WebSocket Server running on port ${port}`);

  wss.on("connection", async (ws: WebSocket, req) => {
    // Extract token from URL query string if provided e.g. /?token=...
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const queryToken = url.searchParams.get("token")?.trim();

    let authenticatedClient: ConnectedClient | null = null;

    async function handleAuthentication(token: string): Promise<boolean> {
      try {
        const device = await verifyDeviceToken(token);
        if (!device) {
          ws.send(JSON.stringify({ type: "error", message: "Unauthorized device token." }));
          ws.close(4401, "Unauthorized");
          return false;
        }

        // Close any existing connection for this device
        const existing = activeClients.get(device.deviceId);
        if (existing && existing.ws !== ws) {
          try {
            existing.ws.close(4000, "Superseded by new connection");
          } catch {
            // ignore
          }
        }

        authenticatedClient = {
          ws,
          device,
          token,
          isAlive: true,
        };
        activeClients.set(device.deviceId, authenticatedClient);
        await setDeviceConnectionStatus(device.deviceId, "connected");

        ws.send(
          JSON.stringify({
            type: "authenticated",
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            userId: device.userId,
            status: "connected",
            timestamp: new Date().toISOString(),
          })
        );
        console.log(`[ULTRON WS] Device connected: ${device.deviceName} (${device.deviceId})`);
        return true;
      } catch (err) {
        console.error("[ULTRON WS] Error during device authentication:", err);
        ws.close(1011, "Internal Server Error");
        return false;
      }
    }

    let authPromise: Promise<boolean> | null = null;

    if (queryToken) {
      authPromise = handleAuthentication(queryToken);
    }

    ws.on("message", async (data: Buffer | string) => {
      try {
        if (authPromise) {
          await authPromise;
        }

        const msg = JSON.parse(data.toString());

        // Initial message-based auth if not done via query string
        if (msg.type === "auth" && typeof msg.token === "string") {
          authPromise = handleAuthentication(msg.token);
          await authPromise;
          return;
        }

        if (!authenticatedClient) {
          ws.send(JSON.stringify({ type: "error", message: "Unauthenticated client." }));
          ws.close(4401, "Unauthenticated");
          return;
        }

        // Heartbeat or ping from Android
        if (msg.type === "heartbeat" || msg.type === "ping") {
          authenticatedClient.isAlive = true;
          const updated = await recordDeviceHeartbeat(authenticatedClient.token);

          ws.send(
            JSON.stringify({
              type: msg.type === "ping" ? "pong" : "heartbeat_ack",
              deviceId: authenticatedClient.device.deviceId,
              lastSeenAt: updated?.lastSeenAt || new Date().toISOString(),
              connectionStatus: "connected",
              timestamp: Date.now(),
            })
          );
        }
      } catch (e) {
        console.warn("[ULTRON WS] Malformed message received:", e);
      }
    });

    ws.on("close", async () => {
      if (authenticatedClient) {
        activeClients.delete(authenticatedClient.device.deviceId);
        await setDeviceConnectionStatus(authenticatedClient.device.deviceId, "offline");
        console.log(`[ULTRON WS] Device disconnected: ${authenticatedClient.device.deviceId}`);
      }
    });

    ws.on("error", (err) => {
      console.error("[ULTRON WS] WebSocket client error:", err);
    });
  });

  return wss;
}

/**
 * Cleanly stops the WebSocket server (for tests and teardown).
 */
export function stopDeviceWebSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!wssInstance) {
      resolve();
      return;
    }

    for (const client of activeClients.values()) {
      try {
        client.ws.terminate();
      } catch {
        // ignore
      }
    }
    activeClients.clear();

    const serverToClose = wssInstance;
    wssInstance = null;

    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    serverToClose.close(() => {
      finish();
    });
    setTimeout(finish, 1000);
  });
}

/**
 * Returns the count of actively connected Android devices.
 */
export function getActiveDeviceConnectionCount(): number {
  return activeClients.size;
}
