// server.ts
import express from "express";
import { Client, Pool } from "pg";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;
// const HOST = "0.0.0.0"; // always use 0.0.0.0 in containers


// WebSocket setup
const wss = new WebSocketServer({ noServer: true });
const clients: Set<WebSocket> = new Set();

wss.on("connection", (ws: WebSocket, req) => {
  console.log("✅ New WebSocket connected.");
  clients.add(ws);// Save the front user WebSocket connection 

  ws.send(JSON.stringify({
    type: "CONNECTION_ESTABLISHED",
    message: "Connected!"
  }));

  ws.on("close", () => {
    console.log("❌ WebSocket disconnected");
    clients.delete(ws);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

// ------------------------
// Database setup
// ------------------------

// 1️⃣ Pool for regular queries (INSERT/SELECT/etc.)
// export const pool = new Pool({
//   connectionString: process.env.DATABASE_URL, // <-- use Neon pooler here (port 5433)
//   max: 5, // keep small; pooler multiplexes behind the scenes
// });
// pool.on("error", (err) => {
//   console.error("Unexpected PG pool error:", err);
// });

// // Helper function for queries
// export async function runQuery(sql: string, params?: any[]) {
//   return pool.query(sql, params);
// }


// Dedicated client for LISTEN/NOTIFY
let pg: Client;

async function connectNotifyClient() {
  pg = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  pg.on("notification", (msg) => {
    console.log("📨 New comment notification received");

    try {
      const payload = JSON.parse(msg.payload as string);
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "NEW_COMMENT",
            data: payload
          }));
        }
      });
      console.log(`✅ Broadcasted to ${clients.size} clients`);
    } catch (error) {
      console.error("Error processing notification:", error);
    }
  });

  pg.on("error", async (err) => {
    console.error("⚠️ Notification client error:", err);
    // Try reconnecting after short delay
    setTimeout(connectNotifyClient, 3000);
  });

  try {
    await pg.connect();
    console.log("✅ Notification client connected");
    await pg.query("LISTEN comments_channel");
    console.log("👂 Listening on comments_channel");
  } catch (err) {
    console.error("❌ Failed to connect notification client:", err);
    setTimeout(connectNotifyClient, 3000);
  }
}

// ------------------------
// Start server
// ------------------------
async function startServer() {
  await connectNotifyClient();
  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });

  server.on('upgrade', (request, socket, head) => {
    // Only accept WS connections on /ws
    if (request.url === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      // Close any other upgrade attempts
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });
}

// ------------------------
// Graceful shutdown
// ------------------------
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  try {
    await pg.end();
    // await pool.end();
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

startServer();
