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
        nickname TEXT
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

    // ensure columns exist (safe)
    db.all(`PRAGMA table_info(users)`, (err, cols) => {
      if (err) return console.error(err);
      const hasNick = (cols || []).some(c => c.name === "nickname");
      if (!hasNick) db.run(`ALTER TABLE users ADD COLUMN nickname TEXT`);
    });

    db.all(`PRAGMA table_info(messages)`, (err, cols) => {
      if (err) return console.error(err);
      const hasReply = (cols || []).some(c => c.name === "reply_to_message_id");
      if (!hasReply) db.run(`ALTER TABLE messages ADD COLUMN reply_to_message_id INTEGER`);
    });
  });
}
ensureSchema();

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});

// ----------------- Auth -----------------
app.post("/api/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });
  if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email" });
  if (String(password).length < 8) return res.status(400).json({ error: "Password too short (min 8)" });

  const hash = await bcrypt.hash(String(password), 10);
  const createdAt = new Date().toISOString();

  db.run(
    `INSERT INTO users (email, password_hash, created_at, nickname) VALUES (?, ?, ?, ?)`,
    [String(email).trim().toLowerCase(), hash, createdAt, null],
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

  db.get(`SELECT id, email, nickname FROM users WHERE id = ?`, [userId], (err, row) => {
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

    // notify connected clients about profile update
    wsBroadcastToUser(uid, { type: "profile:update", userId: uid, nickname: nn });

    res.json({ ok: true, nickname: nn });
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

      // push event to both users
      const payload = {
        type: "message:new",
        message: {
          id: messageId,
          sender_id: Number(senderId),
          receiver_id: Number(receiverId),
          text: trimmed,
          created_at: createdAt,
          reply_to_message_id: replyId
        }
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
    [me, withUser, withUser, me],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json({ ok: true, messages: rows });
    }
  );
});

// mark read: set last read message id for this dialog
app.post("/api/read", (req, res) => {
  const { userId, otherId, lastReadMessageId } = req.body || {};
  const uid = Number(userId);
  const oid = Number(otherId);
  const mid = Number(lastReadMessageId);

  if (!uid || !oid || !mid) return res.status(400).json({ error: "Missing fields" });

  const now = new Date().toISOString();

  db.run(
    `
      INSERT INTO read_state (user_id, other_id, last_read_message_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, other_id)
      DO UPDATE SET last_read_message_id = MAX(read_state.last_read_message_id, excluded.last_read_message_id),
                   updated_at = excluded.updated_at
    `,
    [uid, oid, mid, now],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error" });

      // notify my other clients (same user) to sync read state
      wsBroadcastToUser(uid, { type: "read:update", userId: uid, otherId: oid, lastReadMessageId: mid });

      res.json({ ok: true });
    }
  );
});

// dialogs: last message + unread count + user info (this is what UI uses)
app.get("/api/dialogs", (req, res) => {
  const me = Number(req.query.me);
  if (!me) return res.status(400).json({ error: "Missing query param me" });

  db.all(
    `
      WITH d AS (
        SELECT
          CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS other_id,
          MAX(id) AS last_id
        FROM messages
        WHERE sender_id = ? OR receiver_id = ?
        GROUP BY other_id
      )
      SELECT
        d.other_id,
        d.last_id,
        m.sender_id AS last_sender_id,
        m.receiver_id AS last_receiver_id,
        m.text AS last_text,
        m.created_at AS last_created_at,
        u.id AS user_id,
        u.nickname AS nickname,
        u.email AS email,
        COALESCE((
          SELECT COUNT(1)
          FROM messages im
          LEFT JOIN read_state rs
            ON rs.user_id = ? AND rs.other_id = d.other_id
          WHERE im.sender_id = d.other_id
            AND im.receiver_id = ?
            AND im.id > COALESCE(rs.last_read_message_id, 0)
        ), 0) AS unread_count
      FROM d
      JOIN messages m ON m.id = d.last_id
      JOIN users u ON u.id = d.other_id
      ORDER BY d.last_id DESC
    `,
    [me, me, me, me, me],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json({ ok: true, dialogs: rows || [] });
    }
  );
});

// delete message
app.delete("/api/messages/:id", (req, res) => {
  const messageId = Number(req.params.id);
  const requesterId = Number(req.query.requesterId);
  if (!messageId || !requesterId) return res.status(400).json({ error: "Missing params" });

  db.get(
    `SELECT id, sender_id, receiver_id FROM messages WHERE id = ?`,
    [messageId],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(404).json({ error: "Not found" });

      const ok = (row.sender_id === requesterId || row.receiver_id === requesterId);
      if (!ok) return res.status(403).json({ error: "Forbidden" });

      db.run(`DELETE FROM messages WHERE id = ?`, [messageId], (e) => {
        if (e) return res.status(500).json({ error: "DB error" });

        // broadcast delete event to both sides
        const payload = { type: "message:delete", messageId: messageId };
        wsBroadcastToUser(row.sender_id, payload);
        wsBroadcastToUser(row.receiver_id, payload);

        res.json({ ok: true });
      });
    }
  );
});

// ----------------- WebSocket -----------------
/**
 * client connects to ws://localhost:3000/ws?userId=123
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

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws") {
      ws.close();
      return;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!userId) {
      ws.close();
      return;
    }

    ws.__userId = userId;

    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(ws);

    ws.send(JSON.stringify({ type: "ws:ready" }));

    ws.on("close", () => {
      const set = userSockets.get(userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) userSockets.delete(userId);
      }
    });

    // we don't trust client messages yet — ignore by default
    ws.on("message", () => {});
  } catch {
    ws.close();
  }
});

// ----------------- Start -----------------
server.listen(3000, () => {
  console.log("FroteBiteMessenger ✅ http://localhost:3000");
});