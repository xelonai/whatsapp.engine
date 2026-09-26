const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const pino = require("pino");
const { createClient } = require("@supabase/supabase-js");
const {
  default: makeWASocket,
  initAuthCreds,
  proto,
  BufferJSON,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// In-memory map of active sessions: sessionId -> { sock, qr, status }
const sessions = {};

// ---- Supabase-backed auth state (replaces useMultiFileAuthState) ----
async function useSupabaseAuthState(sessionId) {
  const writeData = async (data, key) => {
    await supabase.from("wa_sessions").upsert({
      session_id: sessionId,
      key,
      value: JSON.stringify(data, BufferJSON.replacer),
      updated_at: new Date().toISOString(),
    });
  };

  const readData = async (key) => {
    const { data } = await supabase
      .from("wa_sessions")
      .select("value")
      .eq("session_id", sessionId)
      .eq("key", key)
      .maybeSingle();
    if (data?.value) return JSON.parse(data.value, BufferJSON.reviver);
    return null;
  };

  const removeData = async (key) => {
    await supabase
      .from("wa_sessions")
      .delete()
      .eq("session_id", sessionId)
      .eq("key", key);
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds"),
  };
}

// ---- Start (or resume) a session for a given sessionId ----
async function startSession(sessionId) {
  const { state, saveCreds } = await useSupabaseAuthState(sessionId);

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

  // Incoming messages (useful for inbox / lead capture later)
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe) {
        const sender = msg.key.remoteJid;
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          null;
        console.log(`[${sessionId}] incoming from ${sender}: ${text}`);
        // TODO: push this into a Supabase table for the dashboard inbox
      }
    }
  });
}

// ---- Routes: every call now takes a sessionId ----

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
