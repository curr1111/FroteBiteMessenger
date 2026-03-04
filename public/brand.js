const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  me: {
    id: Number(localStorage.getItem("fb_userId") || 0),
    email: localStorage.getItem("fb_email") || "",
    nickname: localStorage.getItem("fb_nickname") || "",
  },
  selected: null, // { id, email, nickname }
  view: "chats",
  ws: null,
  replyTo: null, // message id
  lastDialogsSig: "",
};

function requireAuth() {
  if (!state.me.id || !state.me.email) {
    location.href = "./login.html";
    return false;
  }
  return true;
}

function setTheme(theme) {
  document.body.className = `theme-${theme}`;
  localStorage.setItem("fb_theme", theme);
}
(function initTheme() {
  const t = localStorage.getItem("fb_theme") || "ember";
  setTheme(t);
  $$(".themeBtn").forEach(b => b.addEventListener("click", () => setTheme(b.dataset.theme)));
})();

function toastShow(text) {
  const toast = $("#toast");
  const toastText = $("#toastText");
  const toastBarFill = $("#toastBarFill");

  toastText.textContent = text;
  toast.hidden = false;

  toastBarFill.getAnimations().forEach(a => a.cancel());
  toast.getAnimations().forEach(a => a.cancel());

  toastBarFill.animate(
    [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
    { duration: 1500, easing: "linear", fill: "forwards" }
  );

  setTimeout(() => {
    toast.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1500, easing: "ease-out", fill: "forwards" });
    setTimeout(() => (toast.hidden = true), 1500);
  }, 1500);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// **bold**, _italic_, __underline__
function renderMarkup(text) {
  let t = escapeHtml(text);
  t = t.replace(/__([^_]+)__/g, "<u>$1</u>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/_([^_]+)_/g, "<i>$1</i>");
  return t;
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "API error");
  return j;
}

/* ---------------- UI core ---------------- */

function syncRightPane() {
  const chatWrap = $("#chatWrap");
  const callsWrap = $("#callsWrap");

  if (state.view === "calls") {
    callsWrap.hidden = false;
    chatWrap.hidden = true;
    callsWrap.style.animation = "blurIn .22s ease-out";
    return;
  }

  callsWrap.hidden = true;

  // IMPORTANT: hide chat when no selection (per your request)
  chatWrap.hidden = !state.selected;
  if (!chatWrap.hidden) chatWrap.style.animation = "blurIn .22s ease-out";
}

function setView(v) {
  state.view = v;
  $$(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  syncRightPane();
}

function renderUserCard(d) {
  const name = d.nickname || d.email || ("id " + d.user_id);
  const unread = Number(d.unread_count || 0);

  return `
    <div class="user-name">${escapeHtml(name)}</div>
    <div class="user-sub">${escapeHtml(d.email)} · id: ${escapeHtml(String(d.user_id))}</div>
    ${unread > 0 ? `<div class="unread">${unread}</div>` : ``}
  `;
}

async function loadDialogs() {
  const j = await api(`/api/dialogs?me=${state.me.id}`);
  const list = $("#usersList");

  // signature to avoid heavy rerender if unchanged
  const sig = JSON.stringify((j.dialogs || []).map(x => [x.other_id, x.last_id, x.unread_count, x.nickname, x.email]));
  if (sig === state.lastDialogsSig) return;
  state.lastDialogsSig = sig;

  list.innerHTML = "";
  (j.dialogs || []).forEach(d => {
    const el = document.createElement("div");
    el.className = "user";
    el.dataset.uid = String(d.other_id);
    el.innerHTML = renderUserCard(d);

    el.addEventListener("click", () => {
      $$(".user").forEach(x => x.classList.remove("active"));
      el.classList.add("active");
      state.selected = { id: d.other_id, email: d.email, nickname: d.nickname || "" };
      $("#chatTitle").textContent = `Диалог: ${d.nickname || d.email}`;
      state.view = "chats";
      setView("chats");
      loadThread(true);
    });

    list.appendChild(el);
  });

  // keep active highlight if selected
  if (state.selected) {
    const active = list.querySelector(`[data-uid="${state.selected.id}"]`);
    if (active) active.classList.add("active");
  }
}

async function loadThread(markRead) {
  if (!state.selected) return;

  const j = await api(`/api/messages/thread?me=${state.me.id}&with=${state.selected.id}`);
  renderMessages(j.messages || []);

  if (markRead && (j.messages || []).length) {
    const lastId = j.messages[j.messages.length - 1].id;
    await api("/api/read", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ userId: state.me.id, otherId: state.selected.id, lastReadMessageId: lastId })
    }).catch(()=>{});
  }
}

function renderMessages(msgs) {
  const box = $("#messages");
  box.innerHTML = "";

  for (const m of msgs) {
    const mine = Number(m.sender_id) === state.me.id;

    const el = document.createElement("div");
    el.className = `msg ${mine ? "mine" : ""}`;
    el.dataset.mid = String(m.id);

    const meta = new Date(m.created_at).toLocaleString();
    const from = mine ? "Вы" : (state.selected.nickname || state.selected.email);

    let replyHtml = "";
    if (m.reply_to_message_id && m.reply_text) {
      const replyFrom = (Number(m.reply_sender_id) === state.me.id) ? "Вы" : (state.selected.nickname || state.selected.email);
      replyHtml = `
        <div class="replybox">
          <b>Ответ на:</b> ${escapeHtml(replyFrom)}<br/>
          ${renderMarkup(m.reply_text)}
        </div>
      `;
    }

    el.innerHTML = `
      <div class="msg-meta">
        <span>${escapeHtml(from)}</span>
        <span>•</span>
        <span>${escapeHtml(meta)}</span>
        <span>•</span>
        <span>#${escapeHtml(String(m.id))}</span>
      </div>
      <div class="msg-body">${renderMarkup(m.text)}</div>
      ${replyHtml}
    `;

    // context menu
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, m);
    });

    box.appendChild(el);
  }

  box.scrollTop = box.scrollHeight;
}

function openCtxMenu(x, y, msg) {
  const ctx = $("#ctx");
  ctx.hidden = false;
  ctx.style.left = Math.min(x, window.innerWidth - 240) + "px";
  ctx.style.top = Math.min(y, window.innerHeight - 160) + "px";

  ctx.innerHTML = `
    <button class="item" data-act="reply">Ответить</button>
    <button class="item danger" data-act="del">Удалить</button>
  `;

  const onClick = async (e) => {
    const act = e.target?.dataset?.act;
    if (!act) return;

    if (act === "reply") {
      state.replyTo = msg.id;
      const banner = $("#replyBanner");
      banner.hidden = false;
      banner.innerHTML = `<b>Ответ на #${escapeHtml(String(msg.id))}:</b><br/>${renderMarkup(msg.text.slice(0, 180))}`;
      toastShow("Режим ответа включён");
    }

    if (act === "del") {
      try{
        await api(`/api/messages/${msg.id}?requesterId=${state.me.id}`, { method:"DELETE" });
        // WS event also comes, but refresh immediately feels snappy
        await loadThread(false);
      }catch(err){
        toastShow(err.message);
      }
    }

    closeCtxMenu();
  };

  const closeOnOutside = (ev) => {
    if (!ctx.contains(ev.target)) closeCtxMenu();
  };

  ctx.onclick = onClick;
  setTimeout(() => window.addEventListener("click", closeOnOutside, { once:true }), 0);
}

function closeCtxMenu() {
  const ctx = $("#ctx");
  ctx.hidden = true;
  ctx.innerHTML = "";
}

/* ---------------- Search / Add user ---------------- */

$("#btnAdd")?.addEventListener("click", async () => {
  const email = ($("#searchEmail").value || "").trim().toLowerCase();
  const idStr = ($("#searchId").value || "").trim();
  const err = $("#searchErr");

  err.hidden = true;

  if (!email && !idStr) {
    err.hidden = false;
    return;
  }

  try{
    const j = await api("/api/users");
    const users = j.users || [];

    let found = null;

    if (idStr) {
      const id = Number(idStr);
      found = users.find(u => Number(u.id) === id);
    }

    if (!found && email) {
      found = users.find(u => String(u.email).toLowerCase() === email);
    }

    if (!found) {
      err.hidden = false;
      err.animate(
        [{ transform:"translateX(0)" }, { transform:"translateX(-6px)" }, { transform:"translateX(6px)" }, { transform:"translateX(0)" }],
        { duration: 220, easing:"ease-out" }
      );
      return;
    }

    // select chat with found user (even if no messages yet — right panel will open, thread empty)
    state.selected = { id: found.id, email: found.email, nickname: found.nickname || "" };
    $("#chatTitle").textContent = `Диалог: ${found.nickname || found.email}`;
    setView("chats");
    $("#chatWrap").hidden = false;

    // highlight if exists in dialogs list
    $$(".user").forEach(x => x.classList.remove("active"));
    const existing = $("#usersList").querySelector(`[data-uid="${found.id}"]`);
    if (existing) existing.classList.add("active");

    await loadThread(false);

    $("#searchEmail").value = "";
    $("#searchId").value = "";
  }catch(e){
    toastShow(e.message);
  }
});

/* ---------------- Sending ---------------- */

$("#btnRefresh")?.addEventListener("click", () => loadThread(false));

$("#btnSend")?.addEventListener("click", sendMessage);

async function sendMessage() {
  if (!state.selected) return;

  const ta = $("#msgInput");
  const text = (ta.value || "").trim();
  if (!text) return;

  const payload = {
    senderId: state.me.id,
    receiverId: state.selected.id,
    text,
    replyToMessageId: state.replyTo || null
  };

  try{
    await api("/api/messages/send", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });

    ta.value = "";
    state.replyTo = null;
    $("#replyBanner").hidden = true;
    $("#formatBar").hidden = true;

    await loadThread(true);
    await loadDialogs();
  }catch(e){
    toastShow(e.message);
  }
}

/* ---------------- Format bar (selection in textarea) ---------------- */

$("#msgInput")?.addEventListener("mouseup", toggleFormatBar);
$("#msgInput")?.addEventListener("keyup", toggleFormatBar);

function toggleFormatBar() {
  const ta = $("#msgInput");
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const hasSel = typeof start === "number" && typeof end === "number" && end > start;
  $("#formatBar").hidden = !hasSel;
}

$$(".fmt").forEach(btn => {
  btn.addEventListener("click", () => {
    const fmt = btn.dataset.fmt;
    applyFormat(fmt);
  });
});

function applyFormat(fmt) {
  const ta = $("#msgInput");
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  if (!(end > start)) return;

  const before = ta.value.slice(0, start);
  const sel = ta.value.slice(start, end);
  const after = ta.value.slice(end);

  let wrapped = sel;
  if (fmt === "b") wrapped = `**${sel}**`;
  if (fmt === "i") wrapped = `_${sel}_`;
  if (fmt === "u") wrapped = `__${sel}__`;

  ta.value = before + wrapped + after;
  ta.focus();
  ta.selectionStart = start;
  ta.selectionEnd = start + wrapped.length;
  toggleFormatBar();
}

/* ---------------- Profile ---------------- */

const modal = $("#modal");
$("#btnProfile")?.addEventListener("click", async () => {
  try{
    const j = await api(`/api/profile?userId=${state.me.id}`);
    $("#pEmail").textContent = j.user.email;
    $("#pId").textContent = String(j.user.id);
    $("#pNick").value = j.user.nickname || "";
    modal.hidden = false;
  }catch(e){
    toastShow(e.message);
  }
});
$("#modalClose")?.addEventListener("click", () => (modal.hidden = true));
modal?.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

$("#pSave")?.addEventListener("click", async () => {
  const nickname = ($("#pNick").value || "").trim();
  try{
    const j = await api("/api/profile/nickname", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ userId: state.me.id, nickname })
    });
    localStorage.setItem("fb_nickname", j.nickname);
    state.me.nickname = j.nickname;
    modal.hidden = true;
    toastShow("Никнейм обновлён");
    await loadDialogs();
  }catch(e){
    toastShow(e.message);
  }
});

/* ---------------- Logout ---------------- */
$("#btnLogout")?.addEventListener("click", () => {
  localStorage.removeItem("fb_userId");
  localStorage.removeItem("fb_email");
  localStorage.removeItem("fb_nickname");
  location.href = "./login.html";
});

/* ---------------- Calls tab ---------------- */
$("#btnCalls")?.addEventListener("click", () => setView("calls"));
$("#btnBackToChats")?.addEventListener("click", () => setView("chats"));

$$(".navbtn").forEach(btn => btn.addEventListener("click", () => setView(btn.dataset.view)));

/* ---------------- WebSocket realtime ---------------- */

function wsConnect() {
  try{
    const proto = location.protocol === "https:" ? "wss" : "ws";
    state.ws = new WebSocket(`${proto}://${location.host}/ws?userId=${state.me.id}`);

    state.ws.onmessage = async (ev) => {
      let msg;
      try{ msg = JSON.parse(ev.data); }catch{ return; }

      if (msg.type === "message:new") {
        const m = msg.message;

        const isMine = Number(m.sender_id) === state.me.id;
        const otherId = isMine ? Number(m.receiver_id) : Number(m.sender_id);

        // If current open dialog matches — refresh thread + mark read
        if (state.selected && Number(state.selected.id) === otherId && state.view === "chats") {
          await loadThread(true);
        } else {
          toastShow("Новое сообщение");
        }
        await loadDialogs();
      }

      if (msg.type === "message:delete") {
        // If current dialog open — refresh
        if (state.selected && state.view === "chats") {
          await loadThread(false);
        }
        await loadDialogs();
      }

      if (msg.type === "read:update") {
        // just refresh dialogs (unread counters)
        await loadDialogs();
      }

      if (msg.type === "profile:update") {
        await loadDialogs();
      }
    };
  }catch{
    // ignore
  }
}

/* ---------------- Boot ---------------- */

(function boot() {
  if (!requireAuth()) return;

  syncRightPane();
  setView("chats");

  loadDialogs().catch(e => toastShow(e.message));
  wsConnect();

  // refresh dialogs regularly (0.5s as you wanted)
  setInterval(() => {
    loadDialogs().catch(()=>{});
  }, 500);
})();