const express = require("express");
const QRCode = require("qrcode");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json({ limit: "2mb" }));

const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://broadwave.cloud/api/public/inbound";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || process.env.ENGINE_WEBHOOK_SECRET;
const AUTH_ROOT = process.env.AUTH_ROOT || path.join(process.cwd(), "auth_info");
const sessions = new Map();
const contactNames = new Map();

function validSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

// WhatsApp now often addresses chats by a hidden id ("...@lid"); the real number
// is carried in remoteJidAlt / senderPn. Prefer the real phone number.
function keyJid(key) {
  if (!key) return null;
  const candidates = [key.remoteJid, key.remoteJidAlt, key.senderPn, key.participantAlt];
  for (const c of candidates) { const j = cleanJid(c); if (j) return j; }
  return null;
}

function cleanJid(jid) {
  if (typeof jid !== "string") return null;
  const normalized = jid.replace(/:\d+@/, "@");
  if (!normalized.endsWith("@s.whatsapp.net") || normalized.includes("status@broadcast")) return null;
  return normalized;
}

function unixSeconds(value) {
  if (typeof value === "number") return Math.floor(value);
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value.toNumber === "function") return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : Math.floor(Date.now() / 1000);
}

function messageText(message) {
  if (!message) return "";
  const content = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message;
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ""
  );
}

async function postWebhook(payload) {
  if (!WEBHOOK_SECRET) {
    console.error("Webhook error: WEBHOOK_SECRET is not configured");
    return false;
  }

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": WEBHOOK_SECRET,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      const body = await response.text();
      if (response.ok) {
        console.log(`Webhook delivered: ${payload.type} session=${payload.sessionId} status=${response.status}`);
        return true;
      }
      lastError = `HTTP ${response.status}: ${body.slice(0, 500)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  console.error(`Webhook failed: ${payload.type} session=${payload.sessionId}: ${lastError}`);
  return false;
}

function pushMessage(sessionId, raw, type) {
  if (raw?.key?.fromMe) return;
  const jid = keyJid(raw?.key);
  if (!jid || !raw?.message) return;
  const text = messageText(raw.message);
  if (!text) return;

  void postWebhook({
    sessionId,
    type,
    conversation: {
      contactNumber: jid.split("@")[0],
      contactName: raw.pushName || contactNames.get(`${sessionId}:${jid}`) || null,
    },
    message: {
      id: raw.key.id || undefined,
      direction: raw.key.fromMe ? "outgoing" : "incoming",
      text,
      timestamp: unixSeconds(raw.messageTimestamp),
    },
  });
}

let historyQueue = Promise.resolve();
function pushHistory(sessionId, messages) {
  const grouped = new Map();
  for (const raw of messages || []) {
    const jid = keyJid(raw?.key);
    if (!jid || !raw?.message) continue;
    const text = messageText(raw.message);
    if (!text) continue;
    const list = grouped.get(jid) || [];
    list.push({
      id: raw.key.id || undefined,
      direction: raw.key.fromMe ? "outgoing" : "incoming",
      text,
      timestamp: unixSeconds(raw.messageTimestamp),
    });
    grouped.set(jid, list);
  }

  historyQueue = historyQueue.then(async () => {
  for (const [jid, messagesForContact] of grouped) {
    for (let start = 0; start < messagesForContact.length; start += 200) {
      await postWebhook({
        sessionId,
        type: "history_sync",
        conversation: {
          contactNumber: jid.split("@")[0],
          contactName: contactNames.get(`${sessionId}:${jid}`) || null,
        },
        messages: messagesForContact.slice(start, start + 200),
      });
    }
  }
  }).catch((e) => console.error("History push error:", e?.message));
}

async function startSession(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing?.starting || existing?.status === "connected" || existing?.status === "qr_ready") return existing;

  const session = existing || { socket: null, qr: null, status: "connecting", starting: true };
  session.status = "connecting";
  session.starting = true;
  sessions.set(sessionId, session);

  const authPath = path.join(AUTH_ROOT, sessionId);
  fs.mkdirSync(authPath, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const socket = makeWASocket({ auth: state, logger: pino({ level: "silent" }), syncFullHistory: true });
  session.socket = socket;
  session.starting = false;

  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts || []) {
      const jid = cleanJid(contact.id) || cleanJid(contact.phoneNumber) || cleanJid(contact.jid);
      if (jid) contactNames.set(`${sessionId}:${jid}`, contact.name || contact.notify || contact.verifiedName || null);
    }
  });
  socket.ev.on("messaging-history.set", ({ contacts, messages }) => {
    for (const contact of contacts || []) {
      const jid = cleanJid(contact.id) || cleanJid(contact.phoneNumber) || cleanJid(contact.jid);
      if (jid) contactNames.set(`${sessionId}:${jid}`, contact.name || contact.notify || contact.verifiedName || null);
    }
    pushHistory(sessionId, messages);
  });
  socket.ev.on("messages.upsert", ({ messages, type }) => {
    for (const message of messages || []) {
      console.log(`Message event (${type}) session=${sessionId} jid=${message?.key?.remoteJid}`);
      pushMessage(sessionId, message, type === "notify" ? "incoming_message" : "history_sync");
    }
  });
  socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      session.qr = qr;
      session.status = "qr_ready";
    }
    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      console.log(`WhatsApp connected: ${sessionId}`);
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      session.status = "disconnected";
      session.qr = null;
      session.socket = null;
      console.log(`WhatsApp disconnected: ${sessionId}; reconnect=${shouldReconnect}`);
      if (shouldReconnect) setTimeout(() => startSession(sessionId).catch((error) => console.error(`Reconnect failed: ${sessionId}: ${error.message}`)), 1500);
    }
  });

  return session;
}

app.post("/session/start", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!validSessionId(sessionId)) return res.status(400).json({ error: "A valid sessionId is required" });
  try {
    const session = await startSession(sessionId);
    return res.json({ status: session.status });
  } catch (error) {
    console.error(`Session start failed: ${sessionId}: ${error.message}`);
    return res.status(500).json({ error: "Could not start session" });
  }
});

app.get("/session/qr", async (req, res) => {
  const { sessionId } = req.query;
  if (!validSessionId(sessionId)) return res.status(400).json({ error: "A valid sessionId is required" });
  const session = sessions.get(sessionId);
  if (!session?.qr) return res.status(404).json({ error: "No QR available", status: session?.status || "disconnected" });
  return res.json({ qr: await QRCode.toDataURL(session.qr) });
});

app.get("/session/status", (req, res) => {
  const { sessionId } = req.query;
  if (!validSessionId(sessionId)) return res.status(400).json({ error: "A valid sessionId is required" });
  return res.json({ status: sessions.get(sessionId)?.status || "disconnected" });
});

app.post("/send", async (req, res) => {
  const { sessionId, number, message } = req.body || {};
  if (!validSessionId(sessionId)) return res.status(400).json({ error: "A valid sessionId is required" });
  const session = sessions.get(sessionId);
  if (session?.status !== "connected" || !session.socket) return res.status(400).json({ error: "Not connected" });
  const digits = String(number || "").replace(/\D/g, "");
  if (digits.length < 8 || typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "A valid number and message are required" });
  try {
    const result = await session.socket.sendMessage(`${digits}@s.whatsapp.net`, { text: message });
    return res.json({ success: true, messageId: result?.key?.id || null });
  } catch (error) {
    console.error(`Send failed: ${sessionId}: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, sessions: sessions.size }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}; webhook=${WEBHOOK_URL}`));
