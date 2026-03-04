const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database("./db.sqlite");

// ----------------- DB init + migrations -----------------
function ensureSchema() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        nickname TEXT,
        phone TEXT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reply_to_message_id INTEGER,
        FOREIGN KEY(sender_id) REFERENCES users(id),
        FOREIGN KEY(receiver_id) REFERENCES users(id)
      )
    `);

    // read receipts (per dialog)
    db.run(`
      CREATE TABLE IF NOT EXISTS read_state (
        user_id INTEGER NOT NULL,
        other_id INTEGER NOT NULL,
        last_read_message_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, other_id)
      )
    `);

    // ensure columns exist (safe migrations)
    db.all(`PRAGMA table_info(users)`, (err, cols) => {
      if (err) return console.error(err);

      const hasNick = (cols || []).some((c) => c.name === "nickname");
      if (!hasNick) db.run(`ALTER TABLE users ADD COLUMN nickname TEXT`);

      const hasPhone = (cols || []).some((c) => c.name === "phone");
      if (!hasPhone) db.run(`ALTER TABLE users ADD COLUMN phone TEXT`);
    });

    db.all(`PRAGMA table_info(messages)`, (err, cols) => {
      if (err) return console.error(err);
      const hasReply = (cols || []).some((c) => c.name === "reply_to_message_id");
      if (!hasReply) db.run(`ALTER TABLE messages ADD COLUMN reply_to_message_id INTEGER`);
    });
  });
}
ensureSchema();

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// default page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});

// ----------------- WebSocket helpers -----------------
/**
 * client connects to ws://host/ws?userId=123
 * We keep mapping userId -> set of sockets.
 */
const userSockets = new Map(); // userId -> Set(ws)

function wsBroadcastToUser(userId, obj) {
  const set = userSockets.get(Number(userId));
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ----------------- Auth -----------------
app.post("/api/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });
  if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email" });
  if (String(password).length < 8) return res.status(400).json({ error: "Password too short (min 8)" });

  const hash = await bcrypt.hash(String(password), 10);
  const createdAt = new Date().toISOString();

  db.run(
    `INSERT INTO users (email, password_hash, created_at, nickname, phone) VALUES (?, ?, ?, ?, ?)`,
    [String(email).trim().toLowerCase(), hash, createdAt, null, null],
    function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) return res.status(409).json({ error: "Email already exists" });
        return res.status(500).json({ error: "DB error" });
      }
      res.json({ ok: true, userId: this.lastID });
    }
  );
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });

  db.get(
    `SELECT id, email, password_hash, nickname FROM users WHERE email = ?`,
    [String(email).trim().toLowerCase()],
    async (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(401).json({ error: "Invalid email or password" });

      const ok = await bcrypt.compare(String(password), row.password_hash);
      if (!ok) return res.status(401).json({ error: "Invalid email or password" });

      res.json({ ok: true, userId: row.id, email: row.email, nickname: row.nickname || null });
    }
  );
});

// ----------------- Profile -----------------
app.get("/api/profile", (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  db.get(`SELECT id, email, nickname, created_at, phone FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, user: row });
  });
});

// profile of any user by id (for clicking nickname in chat)
app.get("/api/user", (req, res) => {
  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ error: "Missing id" });

  db.get(`SELECT id, email, nickname, created_at, phone FROM users WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, user: row });
  });
});

app.post("/api/profile/nickname", (req, res) => {
  const { userId, nickname } = req.body || {};
  const uid = Number(userId);
  if (!uid) return res.status(400).json({ error: "Missing userId" });

  const nn = String(nickname ?? "").trim().slice(0, 24);
  if (nn.length < 2) return res.status(400).json({ error: "Nickname too short (min 2)" });

  db.run(`UPDATE users SET nickname = ? WHERE id = ?`, [nn, uid], function (err) {
    if (err) return res.status(500).json({ error: "DB error" });

    wsBroadcastToUser(uid, { type: "profile:update", userId: uid, nickname: nn });

    res.json({ ok: true, nickname: nn });
  });
});

app.post("/api/profile/phone", (req, res) => {
  const { userId, phone } = req.body || {};
  const uid = Number(userId);
  if (!uid) return res.status(400).json({ error: "Missing userId" });

  const p = String(phone ?? "").trim().slice(0, 32);
  if (p.length < 6) return res.status(400).json({ error: "Phone too short" });

  db.run(`UPDATE users SET phone = ? WHERE id = ?`, [p, uid], function (err) {
    if (err) return res.status(500).json({ error: "DB error" });

    wsBroadcastToUser(uid, { type: "profile:update", userId: uid });

    res.json({ ok: true, phone: p });
  });
});

// Users list (used for search)
app.get("/api/users", (req, res) => {
  db.all(`SELECT id, email, nickname FROM users ORDER BY id ASC`, (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json({ ok: true, users: rows });
  });
});

// ----------------- Messaging -----------------
app.post("/api/messages/send", (req, res) => {
  const { senderId, receiverId, text, replyToMessageId } = req.body || {};
  if (!senderId || !receiverId || !text) return res.status(400).json({ error: "Missing fields" });

  const createdAt = new Date().toISOString();
  const trimmed = String(text).trim().slice(0, 6000);
  if (!trimmed) return res.status(400).json({ error: "Empty message" });

  const replyId = replyToMessageId ? Number(replyToMessageId) : null;

  db.run(
    `INSERT INTO messages (sender_id, receiver_id, text, created_at, reply_to_message_id)
     VALUES (?, ?, ?, ?, ?)`,
    [Number(senderId), Number(receiverId), trimmed, createdAt, replyId],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error" });

      const messageId = this.lastID;

      const payload = {
        type: "message:new",
        message: {
          id: messageId,
          sender_id: Number(senderId),
          receiver_id: Number(receiverId),
          text: trimmed,
          created_at: createdAt,
          reply_to_message_id: replyId,
        },
      };

      wsBroadcastToUser(Number(senderId), payload);
      wsBroadcastToUser(Number(receiverId), payload);

      res.json({ ok: true, messageId });
    }
  );
});

app.get("/api/messages/thread", (req, res) => {
  const me = Number(req.query.me);
  const withUser = Number(req.query.with);
  if (!me || !withUser) return res.status(400).json({ error: "Missing query params" });

  db.all(
    `
      SELECT
        m.id,
        m.sender_id,
        m.receiver_id,
        m.text,
        m.created_at,
        m.reply_to_message_id,
        rm.text AS reply_text,
        rm.sender_id AS reply_sender_id
      FROM messages m
      LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
      WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
      ORDER BY m.id ASC
      LIMIT 600
    `,
    [me, withUser, withUser