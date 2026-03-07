import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { createRouter } from "./routes.js";
import { setupSocket } from "./socket.js";
import { setupEsp32Gateway } from "./esp32Gateway.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // Set to your frontend URL in production
});

app.use(cors());
app.use(express.json());
app.use("/", createRouter(io));

setupSocket(io);
setupEsp32Gateway(server, io);

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
