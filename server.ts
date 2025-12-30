// server.ts
import express from "express";
import { Client } from "pg";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;
const HOST = "0.0.0.0";

function broadcast(type: string, data: any) {
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type,
          data,
        })
      );
    }
  });

  console.log(`✅ ${type} broadcasted to ${clients.size} clients`);
}


// ------------------------
// WebSocket setup
// ------------------------
// Created the independent WebSocket server that not attached to HTTP server
const wss = new WebSocketServer({ noServer: true });
// all connected clients
const clients: Set<WebSocket> = new Set();
// front client connected to this server and added to the list of clients
wss.on("connection", (ws: WebSocket) => {
  console.log("✅ New WebSocket connected.");
  clients.add(ws);
  // send connection established message to the client to indicate successful connection
  ws.send(JSON.stringify({
    type: "CONNECTION_ESTABLISHED",
    message: "Connected!"
  }));

  ws.on("close", () => {
    console.log("❌ WebSocket disconnected");
    clients.delete(ws);
  });

  ws.on("error", (error) => {
    console.error("⚠️ WebSocket error:", error);
    clients.delete(ws);
  });
});

// ------------------------
// Database LISTEN/NOTIFY client
// ------------------------
let pgClient: Client | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let keepAliveInterval: NodeJS.Timeout | null = null;

async function connectNotifyClient() {
  // Close existing long-running client before creating a new one
  if (pgClient) {
    try {
      await pgClient.end();
    } catch (_) {}
    pgClient = null;
  }
  // Clear any existing keep-alive interval
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }

  pgClient = new Client({
    connectionString: process.env.DATABASE_URL_DIRECT,
    // allows SSL connections even if the certificate isn’t signed by a trusted authority — common for Neon, Railway, or Render Postgres setups.
    ssl: { rejectUnauthorized: false },
  });
  // connect to the database
  try {
    await pgClient.connect();
    console.log("✅ Database connected");
    // Listen to the trigger function created for comments table that listens for new comments
    await pgClient.query("LISTEN comments_channel");
    console.log("👂 Listening on comments_channel");
    // Listen to the trigger function created for messages table that listens for new messages
    await pgClient.query("LISTEN messages_channel");
    console.log("👂 Listening on messages_channel");
    // Keep connection alive (Neon idle timeout 5-10 mins will kill the connection, workaround is to send a ping every 1 min)
    keepAliveInterval = setInterval(async () => {
      if (pgClient) {
        try {
          await pgClient.query("SELECT 1;");
        } catch (err) {
          console.error("⚠️ Keepalive failed:", (err as Error).message);
          scheduleReconnect();
        }
      }
    }, 60_000); // run every 1 minute
    reconnectTimer = null;
  } catch (err) {
    console.error("❌ Failed to connect notification client:", (err as Error).message);
    scheduleReconnect();
  }

  pgClient.on("notification", (msg) => {// a new action made and sent a notification from data base
    console.log(`📨 New ${msg.channel.split('_')[0]} notification received`);

    try {
      const payload = JSON.parse(msg.payload as string);
      // Switch to different channel based on message type
      switch (msg.channel) {
        case "comments_channel":
          broadcast("NEW_COMMENT", payload);
          break;

        case "messages_channel":
          broadcast("NEW_MESSAGE", payload);
          break;

        default:
          console.warn("⚠️ Unknown channel:", msg.channel);
      }

      // clients.forEach((client) => {
      //   if (client.readyState === WebSocket.OPEN) {
      //     client.send(JSON.stringify({
      //       type: "NEW_COMMENT",
      //       data: payload
      //     }));
      //   }
      // });
      // console.log(`✅ Broadcasted to ${clients.size} clients`);
    } catch (error) {
      console.error("⚠️ Error processing notification:", error);
    }
  });

  pgClient.on("error", (err) => {
    console.error("⚠️ Notification client error:", err.message);
    scheduleReconnect();
  });

  pgClient.on("end", () => {
    console.warn("⚠️ PG client ended, scheduling reconnect...");
    scheduleReconnect();
  });
}

// Reconnect logic
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNotifyClient();
  }, 5000); // 5s delay
}

// Keep connection alive (Neon idle timeout 5-10 mins will kill the connection, workaround is to send a ping every 1 min)
keepAliveInterval = setInterval(async () => {
  if (pgClient) {
    try {
      await pgClient.query("SELECT 1;");
    } catch (err) {
      console.error("⚠️ Keepalive failed:", (err as Error).message);
      scheduleReconnect();
    }
  }
}, 60_000); // run every 1 minute

// ------------------------
// Start server
// ------------------------
async function startServer() {
  await connectNotifyClient();

  const server = app.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });

  server.on("upgrade", (request, socket, head) => {
    console.log("🔌 WS upgrade attempt from origin:", request.headers.origin);
    if (request.url === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });
}

// ------------------------
// Graceful shutdown
// ------------------------
process.on("SIGINT", async () => {
  console.log("🛑 Shutting down gracefully...");
  try {
    if (pgClient) await pgClient.end();
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

startServer();
