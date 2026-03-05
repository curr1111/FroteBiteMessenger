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
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database("./db.sqlite");

// ----------------- helpers -----------------
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}
function nowIso() {
  return new Date().toISOString();
}
function safeStr(v, max = 256) {
  return String(v ?? "").trim().slice(0, max);
}

// ----------------- schema + migrations -----------------
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

    db.run(`
      CREATE TABLE IF NOT EXISTS read_state (
        user_id INTEGER NOT NULL,
        other_id INTEGER NOT NULL,
        last_read_message_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, other_id)
      )
    `);

    // safe migrations
    db.all(`PRAGMA table_info(users)`, (err, cols) => {
      if (err) return console.error(err);
      const c = cols || [];
      const hasNick = c.some(x => x.name === "nickname");
      const hasPhone = c.some(x => x.name === "phone");
      if (!hasNick) db.run(`ALTER TABLE users ADD COLUMN nickname TEXT`);
      if (!hasPhone) db.run(`ALTER TABLE users ADD COLUMN phone TEXT`);
    });

    db.all(`PRAGMA table_info(messages)`, (err, cols) => {
      if (err) return console.error(err);
      const c = cols || [];
      const hasReply = c.some(x => x.name === "reply_to_message_id");
      if (!hasReply) db.run(`ALTER TABLE messages ADD COLUMN reply_to_message_id INTEGER`);
    });
  });
}
ensureSchema();

// ----------------- pages -----------------
// Удобно: если открыли сайт по / — кидаем на login.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// ----------------- Auth -----------------
app.post("/api/register", async (req, res) => {
  try {
    const email = safeStr(req.body?.email, 120).toLowerCase();
    const password = String(req.body?.password ?? "");

    if (!email || !password) return res.status(400).json({ error: "Missing fields" });
    if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email" });
    if (password.length < 8) return res.status(400).json({ error: "Password too short (min 8)" });

    const hash = await bcrypt.hash(password, 10);
    const createdAt = nowIso();

    db.run(
      `INSERT INTO users (email, password_hash, created_at, nickname, phone) VALUES (?, ?, ?, ?, ?)`,
      [email, hash, createdAt, null, null],
      function (err) {
        if (err) {
          if (String(err.message || "").includes("UNIQUE")) {
            return res.status(409).json({ error: "Email already exists" });
          }
          return res.status(500).json({ error: "DB error" });
        }
        res.json({ ok: true, userId: this.lastID });
      }
    );
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", (req, res) => {
  const email = safeStr(req.body?.email, 120).toLowerCase();
  const password = String(req.body?.password ?? "");

  if (!email || !password) return res.status(400).json({ error: "Missing fields" });

  db.get(
    `SELECT id, email, password_hash, nickname, phone, created_at FROM users WHERE email = ?`,
    [email],
    async (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(401).json({ error: "Invalid email or password" });

      const ok = await bcrypt.compare(password, row.password_hash);
      if (!ok) return res.status(401).json({ error: "Invalid email or password" });

      res.json({
        ok: true,
        user: {
          id: row.id,
          email: row.email,
          nickname: row.nickname || null,
          phone: row.phone || null,
          created_at: row.created_at
        }
      });
    }
  );
});

// ----------------- Profile -----------------
app.get("/api/profile", (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  db.get(
    `SELECT id, email, nickname, phone, created_at FROM users WHERE id = ?`,
    [userId],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ ok: true, user: row });
    }
  );
});

app.post("/api/profile/nickname", (req, res) => {
  const uid = Number(req.body?.userId);
  const nickname = safeStr(req.body?.nickname, 24);

  if (!uid) return res.status(400).json({ error: "Missing userId" });
  if (nickname.length < 2) return res.status(400).json({ error: "Nickname too short (min 2)" });

  db.run(`UPDATE users SET nickname = ? WHERE id = ?`, [nickname, uid], (err) => {
    if (err) return res.status(500).json({ error: "DB error" });

    wsBroadcastToUser(uid, { type: "profile:update", userId: uid, nickname });
    res.json({ ok: true, nickname });
  });
});

app.post("/api/profile/phone", (req, res) => {
  const uid = Number(req.body?.userId);
  const phone = safeStr(req.body?.phone, 32);

  if (!uid) return res.status(400).json({ error: "Missing userId" });
  if (phone.length < 5) return res.status(400).json({ error: "Phone too short" });

  db.run(`UPDATE users SET phone = ? WHERE id = ?`, [phone, uid], (err) => {
    if (err) return res.status(500).json({ error: "DB error" });

    wsBroadcastToUser(uid, { type: "profile:update", userId: uid, phone });
    res.json({ ok: true, phone });
  });
});

// Users list (for UI search)
app.get("/api/users", (req, res) => {
  db.all(`SELECT id, email, nickname, phone, created_at FROM users ORDER BY id ASC`, (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json({ ok: true, users: rows || [] });
  });
});

// Find user by email or id
app.get("/api/users/find", (req, res) => {
  const id = Number(req.query.id);
  const email = safeStr(req.query.email, 120).toLowerCase();

  if (!id && !email) return res.status(400).json({ error: "Missing query" });

  if (id) {
    db.get(`SELECT id, email, nickname, phone, created_at FROM users WHERE id = ?`, [id], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ ok: true, user: row });
    });
    return;
  }

  if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email" });

  db.get(`SELECT id, email, nickname, phone, created_at FROM users WHERE email = ?`, [email], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, user: row });
  });
});

// ----------------- Messaging -----------------
app.post("/api/messages/send", (req, res) => {
  const senderId = Number(req.body?.senderId);
  const receiverId = Number(req.body?.receiverId);
  const text = safeStr(req.body?.text, 6000);
  const replyToMessageId = req.body?.replyToMessageId ? Number(req.body.replyToMessageId) : null;

  if (!senderId || !receiverId || !text) return res.status(400).json({ error: "Missing fields" });

  const createdAt = nowIso();

  db.run(
    `INSERT INTO messages (sender_id, receiver_id, text, created_at, reply_to_message_id)
     VALUES (?, ?, ?, ?, ?)`,
    [senderId, receiverId, text, createdAt, replyToMessageId],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error" });

      const messageId = this.lastID;

      const payload = {
        type: "message:new",
        message: {
          id: messageId,
          sender_id: senderId,
          receiver_id: receiverId,
          text,
          created_at: createdAt,
          reply_to_message_id: replyToMessageId
        }
      };

      wsBroadcastToUser(senderId, payload);
      wsBroadcastToUser(receiverId, payload);

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
      res.json({ ok: true, messages: rows || [] });
    }
  );
});

// read receipts
app.post("/api/read", (req, res) => {
  const uid = Number(req.body?.userId);
  const oid = Number(req.body?.otherId);
  const mid = Number(req.body?.lastReadMessageId);

  if (!uid || !oid || !mid) return res.status(400).json({ error: "Missing fields" });

  db.run(
    `
      INSERT INTO read_state (user_id, other_id, last_read_message_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, other_id)
      DO UPDATE SET last_read_message_id = MAX(read_state.last_read_message_id, excluded.last_read_message_id),
                   updated_at = excluded.updated_at
    `,
    [uid, oid, mid, nowIso()],
    (err) => {
      if (err) return res.status(500).json({ error: "DB error" });

      wsBroadcastToUser(uid, { type: "read:update", userId: uid, otherId: oid, lastReadMessageId: mid });
      res.json({ ok: true });
    }
  );
});

// dialogs list
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

  db.get(`SELECT id, sender_id, receiver_id FROM messages WHERE id = ?`, [messageId], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Not found" });

    const ok = row.sender_id === requesterId || row.receiver_id === requesterId;
    if (!ok) return res.status(403).json({ error: "Forbidden" });

    db.run(`DELETE FROM messages WHERE id = ?`, [messageId], (e) => {
      if (e) return res.status(500).json({ error: "DB error" });

      const payload = { type: "message:delete", messageId };
      wsBroadcastToUser(row.sender_id, payload);
      wsBroadcastToUser(row.receiver_id, payload);

      res.json({ ok: true });
    });
  });
});

// ----------------- WebSocket -----------------
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
    if (url.pathname !== "/ws") return ws.close();

    const userId = Number(url.searchParams.get("userId"));
    if (!userId) return ws.close();

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

    ws.on("message", () => {
      // пока игнорируем входящие сообщения от клиента
    });
  } catch {
    ws.close();
  }
});

// ----------------- start -----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("FroteBiteMessenger ✅ http://localhost:" + PORT);
});