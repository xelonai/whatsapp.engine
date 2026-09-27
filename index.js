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

// ---- Webhook helper: forwards data to the Lovable inbox endpoint ----
async function sendToInbox(payload) {
  try {
    const res = await fetch(process.env.WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": process.env.WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("Webhook failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
}

// ---- Start (or resume) a session for a given sessionId ----
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

  // ---- Connection state changes ----
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

  // ---- Real-time incoming messages ----
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe) {
        const sender = msg.key.remoteJid?.replace("@s.whatsapp.net", "");
        if (!sender || msg.key.remoteJid?.includes("@g.us")) continue; // skip groups

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          null;
        if (!text) continue;

        sendToInbox({
          sessionId,
          type: "incoming_message",
          conversation: {
            contactNumber: sender,
            contactName: msg.pushName || null,
          },
          message: {
            direction: "incoming",
            text,
            timestamp: Math.floor(Date.now() / 1000),
          },
        });
      }
    }
  });

  // ---- Initial history sync (fires once on first connect) ----
  sock.ev.on("messaging-history.set", ({ messages }) => {
    const grouped = {};

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid.includes("@g.us")) continue; // skip group chats

      const number = jid.replace("@s.whatsapp.net", "");
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        null;
      if (!text) continue;

      if (!grouped[number]) grouped[number] = [];
      grouped[number].push({
        direction: msg.key.fromMe ? "outgoing" : "incoming",
        text,
        timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
      });
    }

    for (const [number, msgs] of Object.entries(grouped)) {
      sendToInbox({
        sessionId,
        type: "history_sync",
        conversation: { contactNumber: number, contactName: null },
        messages: msgs,
      });
    }
  });
}

// ---- Routes ----

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

// ---- Send a message (also forwards it to the inbox as an outgoing message) ----
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

    // Forward this outgoing message to the inbox so it shows in the thread
    sendToInbox({
      sessionId,
      type: "incoming_message", // reuse the same handler; direction marks it outgoing
      conversation: {
        contactNumber: number.replace("@s.whatsapp.net", ""),
        contactName: null,
      },
      message: {
        direction: "outgoing",
        text: message,
        timestamp: Math.floor(Date.now() / 1000),
      },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
