const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database("./db.sqlite");

// -------------------- helpers --------------------
function nowIso() {
  return new Date().toISOString();
}

function safeStr(v, max = 5000) {
  return String(v ?? "").trim().slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// -------------------- websocket --------------------
const userSockets = new Map(); // userId -> Set(ws)

function wsBroadcastToUser(userId, payload) {
  const set = userSockets.get(Number(userId));
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function wsBroadcastMany(userIds, payload) {
  const unique = [...new Set(userIds.map(Number))];
  unique.forEach((id) => wsBroadcastToUser(id, payload));
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

    ws.on("message", () => {});
  } catch {
    ws.close();
  }
});

// -------------------- schema --------------------
async function ensureSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      nickname TEXT,
      phone TEXT
    )
  `);

  await run(`
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

  await run(`
    CREATE TABLE IF NOT EXISTS read_state (
      user_id INTEGER NOT NULL,
      other_id INTEGER NOT NULL,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, other_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      is_read_only INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS channel_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      title TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(channel_id) REFERENCES channels(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id INTEGER NOT NULL,
      callee_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      FOREIGN KEY(caller_id) REFERENCES users(id),
      FOREIGN KEY(callee_id) REFERENCES users(id)
    )
  `);

  const logChannel = await get(`SELECT id FROM channels WHERE slug = ?`, ["logs-updates"]);
  if (!logChannel) {
    const ins = await run(
      `INSERT INTO channels (slug, title, description, is_read_only, created_at) VALUES (?, ?, ?, ?, ?)`,
      [
        "logs-updates",
        "Логи и Обновления",
        "Системный канал. Только чтение.",
        1,
        nowIso()
      ]
    );

    await run(
      `INSERT INTO channel_posts (channel_id, title, body, created_at) VALUES (?, ?, ?, ?)`,
      [
        ins.lastID,
        "Старт канала",
        "Канал создан автоматически. Здесь будут появляться обновления мессенджера.",
        nowIso()
      ]
    );
  }
}

ensureSchema().catch(console.error);

// -------------------- root --------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// -------------------- auth --------------------
app.post("/api/register", async (req, res) => {
  try {
    const email = safeStr(req.body?.email, 120).toLowerCase();
    const password = String(req.body?.password ?? "");

    if (!email || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password too short (min 8)" });
    }

    const exists = await get(`SELECT id FROM users WHERE email = ?`, [email]);
    if (exists) {
      return res.status(409).json({ error: "Email already exists" });
    }

    const hash = await bcrypt.hash(password, 10);
    const createdAt = nowIso();

    const result = await run(
      `INSERT INTO users (email, password_hash, created_at, nickname, phone) VALUES (?, ?, ?, ?, ?)`,
      [email, hash, createdAt, null, null]
    );

    res.json({ ok: true, userId: result.lastID });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = safeStr(req.body?.email, 120).toLowerCase();
    const password = String(req.body?.password ?? "");

    if (!email || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const user = await get(
      `SELECT id, email, password_hash, nickname, phone, created_at FROM users WHERE email = ?`,
      [email]
    );

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname || null,
        phone: user.phone || null,
        created_at: user.created_at
      }
    });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- profile --------------------
app.get("/api/profile", async (req, res) => {
  try {
    const userId = Number(req.query.userId);
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const user = await get(
      `SELECT id, email, nickname, phone, created_at FROM users WHERE id = ?`,
      [userId]
    );
    if (!user) return res.status(404).json({ error: "Not found" });

    res.json({ ok: true, user });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/profile/nickname", async (req, res) => {
  try {
    const userId = Number(req.body?.userId);
    const nickname = safeStr(req.body?.nickname, 32);

    if (!userId) return res.status(400).json({ error: "Missing userId" });
    if (nickname.length < 2) {
      return res.status(400).json({ error: "Nickname too short (min 2)" });
    }

    await run(`UPDATE users SET nickname = ? WHERE id = ?`, [nickname, userId]);

    wsBroadcastToUser(userId, {
      type: "profile:update",
      userId,
      nickname
    });

    res.json({ ok: true, nickname });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/profile/phone", async (req, res) => {
  try {
    const userId = Number(req.body?.userId);
    const phone = safeStr(req.body?.phone, 32);

    if (!userId) return res.status(400).json({ error: "Missing userId" });
    if (phone.length < 5) return res.status(400).json({ error: "Phone too short" });

    await run(`UPDATE users SET phone = ? WHERE id = ?`, [phone, userId]);

    wsBroadcastToUser(userId, {
      type: "profile:update",
      userId,
      phone
    });

    res.json({ ok: true, phone });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- users search --------------------
app.get("/api/users/find", async (req, res) => {
  try {
    const id = Number(req.query.id);
    const email = safeStr(req.query.email, 120).toLowerCase();

    let user = null;

    if (id) {
      user = await get(
        `SELECT id, email, nickname, phone, created_at FROM users WHERE id = ?`,
        [id]
      );
    } else if (email) {
      user = await get(
        `SELECT id, email, nickname, phone, created_at FROM users WHERE email = ?`,
        [email]
      );
    } else {
      return res.status(400).json({ error: "Missing query" });
    }

    if (!user) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, user });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- dialogs --------------------
app.get("/api/dialogs", async (req, res) => {
  try {
    const me = Number(req.query.me);
    if (!me) return res.status(400).json({ error: "Missing me" });

    const dialogs = await all(
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
        u.email AS email,
        u.nickname AS nickname,
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
      [me, me, me, me, me]
    );

    res.json({ ok: true, dialogs });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- messages --------------------
app.get("/api/messages/thread", async (req, res) => {
  try {
    const me = Number(req.query.me);
    const withUser = Number(req.query.with);
    if (!me || !withUser) {
      return res.status(400).json({ error: "Missing query params" });
    }

    const messages = await all(
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
      WHERE (m.sender_id = ? AND m.receiver_id = ?)
         OR (m.sender_id = ? AND m.receiver_id = ?)
      ORDER BY m.id ASC
      LIMIT 800
      `,
      [me, withUser, withUser, me]
    );

    res.json({ ok: true, messages });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/messages/send", async (req, res) => {
  try {
    const senderId = Number(req.body?.senderId);
    const receiverId = Number(req.body?.receiverId);
    const text = safeStr(req.body?.text, 6000);
    const replyToMessageId = req.body?.replyToMessageId ? Number(req.body.replyToMessageId) : null;

    if (!senderId || !receiverId || !text) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const createdAt = nowIso();
    const ins = await run(
      `INSERT INTO messages (sender_id, receiver_id, text, created_at, reply_to_message_id)
       VALUES (?, ?, ?, ?, ?)`,
      [senderId, receiverId, text, createdAt, replyToMessageId]
    );

    const payload = {
      type: "message:new",
      message: {
        id: ins.lastID,
        sender_id: senderId,
        receiver_id: receiverId,
        text,
        created_at: createdAt,
        reply_to_message_id: replyToMessageId
      }
    };

    wsBroadcastMany([senderId, receiverId], payload);

    res.json({ ok: true, messageId: ins.lastID });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/messages/:id", async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    const requesterId = Number(req.query.requesterId);

    if (!messageId || !requesterId) {
      return res.status(400).json({ error: "Missing params" });
    }

    const row = await get(
      `SELECT id, sender_id, receiver_id FROM messages WHERE id = ?`,
      [messageId]
    );

    if (!row) return res.status(404).json({ error: "Not found" });

    const allowed = row.sender_id === requesterId || row.receiver_id === requesterId;
    if (!allowed) return res.status(403).json({ error: "Forbidden" });

    await run(`DELETE FROM messages WHERE id = ?`, [messageId]);

    wsBroadcastMany([row.sender_id, row.receiver_id], {
      type: "message:delete",
      messageId
    });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/read", async (req, res) => {
  try {
    const userId = Number(req.body?.userId);
    const otherId = Number(req.body?.otherId);
    const lastReadMessageId = Number(req.body?.lastReadMessageId);

    if (!userId || !otherId || !lastReadMessageId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await run(
      `
      INSERT INTO read_state (user_id, other_id, last_read_message_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, other_id)
      DO UPDATE SET
        last_read_message_id = CASE
          WHEN excluded.last_read_message_id > read_state.last_read_message_id
          THEN excluded.last_read_message_id
          ELSE read_state.last_read_message_id
        END,
        updated_at = excluded.updated_at
      `,
      [userId, otherId, lastReadMessageId, nowIso()]
    );

    wsBroadcastToUser(userId, {
      type: "read:update",
      userId,
      otherId,
      lastReadMessageId
    });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- channels --------------------
app.get("/api/channels", async (req, res) => {
  try {
    const channels = await all(
      `SELECT id, slug, title, description, is_read_only, created_at
       FROM channels
       ORDER BY id ASC`
    );
    res.json({ ok: true, channels });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/channels/:id/posts", async (req, res) => {
  try {
    const channelId = Number(req.params.id);
    if (!channelId) return res.status(400).json({ error: "Invalid channel id" });

    const channel = await get(`SELECT * FROM channels WHERE id = ?`, [channelId]);
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    const posts = await all(
      `SELECT id, title, body, created_at
       FROM channel_posts
       WHERE channel_id = ?
       ORDER BY id DESC`,
      [channelId]
    );

    res.json({ ok: true, channel, posts });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// системная публикация обновлений
app.post("/api/system/log", async (req, res) => {
  try {
    const secret = safeStr(req.body?.secret, 120);
    const title = safeStr(req.body?.title, 180);
    const body = safeStr(req.body?.body, 4000);

    if (secret !== "frotebite-system") {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!body) {
      return res.status(400).json({ error: "Empty body" });
    }

    const channel = await get(`SELECT id FROM channels WHERE slug = ?`, ["logs-updates"]);
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    const createdAt = nowIso();
    const ins = await run(
      `INSERT INTO channel_posts (channel_id, title, body, created_at) VALUES (?, ?, ?, ?)`,
      [channel.id, title || "Обновление", body, createdAt]
    );

    // шлём всем пользователям онлайн
    for (const [userId, set] of userSockets.entries()) {
      if (set.size > 0) {
        wsBroadcastToUser(userId, {
          type: "channel:newpost",
          channelId: channel.id,
          post: {
            id: ins.lastID,
            title: title || "Обновление",
            body,
            created_at: createdAt
          }
        });
      }
    }

    res.json({ ok: true, postId: ins.lastID });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- calls --------------------
app.get("/api/calls", async (req, res) => {
  try {
    const userId = Number(req.query.userId);
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const calls = await all(
      `
      SELECT
        c.id,
        c.caller_id,
        c.callee_id,
        c.status,
        c.created_at,
        c.ended_at,
        cu.email AS caller_email,
        cu.nickname AS caller_nickname,
        ce.email AS callee_email,
        ce.nickname AS callee_nickname
      FROM calls c
      JOIN users cu ON cu.id = c.caller_id
      JOIN users ce ON ce.id = c.callee_id
      WHERE c.caller_id = ? OR c.callee_id = ?
      ORDER BY c.id DESC
      LIMIT 100
      `,
      [userId, userId]
    );

    res.json({ ok: true, calls });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/calls/start", async (req, res) => {
  try {
    const callerId = Number(req.body?.callerId);
    const calleeId = Number(req.body?.calleeId);

    if (!callerId || !calleeId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const createdAt = nowIso();
    const ins = await run(
      `INSERT INTO calls (caller_id, callee_id, status, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?)`,
      [callerId, calleeId, "ringing", createdAt, null]
    );

    const payload = {
      type: "call:new",
      call: {
        id: ins.lastID,
        caller_id: callerId,
        callee_id: calleeId,
        status: "ringing",
        created_at: createdAt
      }
    };

    wsBroadcastMany([callerId, calleeId], payload);

    res.json({ ok: true, callId: ins.lastID });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- start --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("FroteBiteMessenger ✅ http://localhost:" + PORT);
});