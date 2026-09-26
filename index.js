const express = require("express");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());

let sock = null;
let currentQR = null;
let connectionStatus = "disconnected"; // disconnected | connecting | qr_ready | connected

async function startSession() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      connectionStatus = "qr_ready";
    }

    if (connection === "open") {
      connectionStatus = "connected";
      currentQR = null;
      console.log("WhatsApp connected");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      connectionStatus = "disconnected";
      console.log("Connection closed, reconnecting:", shouldReconnect);
      if (shouldReconnect) startSession();
    }
  });
}

// Start a session (or return current status if already running)
app.post("/session/start", async (req, res) => {
  if (!sock) {
    connectionStatus = "connecting";
    startSession();
  }
  res.json({ status: connectionStatus });
});

// Get current QR code as a scannable image
app.get("/session/qr", async (req, res) => {
  if (!currentQR) {
    return res.status(404).json({ error: "No QR available", status: connectionStatus });
  }
  const qrImage = await QRCode.toDataURL(currentQR);
  res.json({ qr: qrImage });
});

// Check connection status
app.get("/session/status", (req, res) => {
  res.json({ status: connectionStatus });
});

// Send a message
app.post("/send", async (req, res) => {
  const { number, message } = req.body;
  if (connectionStatus !== "connected") {
    return res.status(400).json({ error: "Not connected" });
  }
  try {
    const jid = number.includes("@s.whatsapp.net") ? number : `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
