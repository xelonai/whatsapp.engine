const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

const sessions = {}; // sessionId -> { sock, qr, status }

async function startSession(sessionId) {
  const { state, saveCreds } = await useMultiFileAuthState(
    `/data/auth_info/${sessionId}`
  );

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sessions[sessionId] = { sock, qr: null, status: "connecting" };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    const entry = sessions[sessionId];
    if (!entry) return;

    if (qr) {
      entry.qr = qr;
      entry.status = "qr_ready";
    }

    if (connection === "open") {
      entry.status = "connected";
      entry.qr = null;
      console.log(`[${sessionId}] connected`);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      entry.status = "disconnected";
      console.log(`[${sessionId}] closed, reconnect:`, shouldReconnect);
      if (shouldReconnect) startSession(sessionId);
    }
  });

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe) {
        const sender = msg.key.remoteJid;
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          null;
        console.log(`[${sessionId}] incoming from ${sender}: ${text}`);
      }
    }
  });
}

app.post("/session/start", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  if (!sessions[sessionId] || sessions[sessionId].status === "disconnected") {
    await startSession(sessionId);
  }
  res.json({ status: sessions[sessionId]?.status || "connecting" });
});

app.get("/session/qr", async (req, res) => {
  const { sessionId } = req.query;
  const entry = sessions[sessionId];
  if (!entry?.qr) {
    return res.status(404).json({
      error: "No QR available",
      status: entry?.status || "disconnected",
    });
  }
  const qrImage = await QRCode.toDataURL(entry.qr);
  res.json({ qr: qrImage });
});

app.get("/session/status", (req, res) => {
  const { sessionId } = req.query;
  const entry = sessions[sessionId];
  res.json({ status: entry?.status || "disconnected" });
});

app.post("/send", async (req, res) => {
  const { sessionId, number, message } = req.body;
  const entry = sessions[sessionId];
  if (!entry || entry.status !== "connected") {
    return res.status(400).json({ error: "Session not connected" });
  }
  try {
    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;
    await entry.sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
