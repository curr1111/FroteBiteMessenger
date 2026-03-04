/* ==========================
   FroteBiteMessenger — UI/Logic
   Works with server.js endpoints:
   /api/register, /api/login, /api/dialogs, /api/messages/thread, /api/messages/send
   /api/messages/:id (DELETE), /api/profile, /api/user, /api/profile/nickname, /api/profile/phone
   WebSocket: /ws?userId=...
========================== */

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- Helpers ----------
  const store = {
    get(key, fallback = null) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
    del(key) { localStorage.removeItem(key); },
    clearAuth() {
      store.del("fb_user");
    }
  };

  function setFadeIn() {
    const overlay = $("#fadeOverlay");
    if (!overlay) return;
    requestAnimationFrame(() => overlay.classList.add("off"));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleString("ru-RU", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
    } catch {
      return iso;
    }
  }

  function showError(el, msg) {
    if (!el) return;
    el.textContent = msg || "";
    if (!msg) { el.classList.remove("show"); return; }
    el.classList.add("show");
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error || `HTTP ${res.status}`;
      throw new Error(err);
    }
    return data;
  }

  // Basic HTML sanitizer: allow only a small subset
  function sanitizeHtml(html) {
    if (!html) return "";
    // remove scripts/styles
    html = html.replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "");
    html = html.replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, "");

    // allow only b,i,u,br,div,span
    // strip other tags to text
    html = html.replace(/<\/?(?!b|i|u|br|div|span)\w+[^>]*>/gi, "");

    // strip dangerous attrs
    html = html.replace(/\son\w+="[^"]*"/gi, "");
    html = html.replace(/\son\w+='[^']*'/gi, "");
    html = html.replace(/\sstyle="[^"]*"/gi, ""); // no inline styles
    html = html.replace(/\sstyle='[^']*'/gi, "");
    return html;
  }

  function plainFromHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html || "";
    return (tmp.textContent || "").trim();
  }

  function toast(title, sub) {
    const wrap = $("#toasts");
    if (!wrap) return;
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `
      <div class="toast-title"></div>
      <div class="toast-sub"></div>
      <div class="toast-bar"></div>
    `;
    t.querySelector(".toast-title").textContent = title || "Уведомление";
    t.querySelector(".toast-sub").textContent = sub || "";
    wrap.appendChild(t);

    // fade after 1.5s bar ends
    setTimeout(() => t.classList.add("fade"), 1500);
    setTimeout(() => t.remove(), 1500 + 1500);
  }

  // ---------- Theme ----------
  function applyTheme(theme) {
    document.body.setAttribute("data-theme", theme);
    store.set("fb_theme", theme);
  }

  function initTheme() {
    const theme = store.get("fb_theme", "ember");
    applyTheme(theme);
  }

  // ---------- Auth pages ----------
  async function initRegister() {
    const form = $("#registerForm");
    if (!form) return;

    const errEl = $("#authError");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      showError(errEl, "");

      const email = ($("#regEmail")?.value || "").trim();
      const password = ($("#regPass")?.value || "");

      try {
        const r = await api("/api/register", {
          method: "POST",
          body: JSON.stringify({ email, password })
        });

        // after register -> go login
        toast("Аккаунт создан ✅", "Теперь войди в аккаунт");
        await sleep(400);
        location.href = "login.html";
      } catch (e2) {
        showError(errEl, e2.message);
      }
    });
  }

  async function initLogin() {
    const form = $("#loginForm");
    if (!form) return;

    const errEl = $("#authError");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      showError(errEl, "");

      const email = ($("#loginEmail")?.value || "").trim();
      const password = ($("#loginPass")?.value || "");

      try {
        const r = await api("/api/login", {
          method: "POST",
          body: JSON.stringify({ email, password })
        });

        store.set("fb_user", {
          userId: r.userId,
          email: r.email,
          nickname: r.nickname || null
        });

        location.href = "chat.html";
      } catch (e2) {
        showError(errEl, e2.message);
      }
    });
  }

  // ---------- Chat page state ----------
  const state = {
    me: null,              // {userId,email,nickname}
    ws: null,
    wsReady: false,
    dialogs: [],
    activeOtherId: null,
    activeOther: null,     // {id,email,nickname,created_at,phone}
    thread: [],
    replyTo: null,         // message object
    knownMessageIds: new Set(),
    lastToastByDialog: new Map(), // otherId->timestamp
    calls: []
  };

  function requireAuth() {
    const me = store.get("fb_user", null);
    if (!me || !me.userId) {
      location.href = "login.html";
      return null;
    }
    return me;
  }

  // ---------- UI refs ----------
  function ui() {
    return {
      topStatus: $("#topStatus"),
      btnLogout: $("#btnLogout"),
      btnSettings: $("#btnSettings"),

      tabChats: $("#tabChats"),
      tabCalls: $("#tabCalls"),
      viewChats: $("#viewChats"),
      viewCalls: $("#viewCalls"),

      dialogs: $("#dialogs"),
      btnAddUser: $("#btnAddUser"),
      searchEmail: $("#searchEmail"),
      searchId: $("#searchId"),
      searchHint: $("#searchHint"),
      searchError: $("#searchError"),

      noChat: $("#noChat"),
      threadWrap: $("#threadWrap"),
      thread: $("#thread"),
      emptyThread: $("#emptyThread"),

      chatWithName: $("#chatWithName"),
      btnOpenUserCard: $("#btnOpenUserCard"),
      btnCall: $("#btnCall"),
      btnRefresh: $("#btnRefresh"),
      btnSend: $("#btnSend"),
      btnDone: $("#btnDone"),

      editor: $("#editor"),
      formatBar: $("#formatBar"),
      replyBox: $("#replyBox"),
      replyPreview: $("#replyPreview"),
      replyCancel: $("#replyCancel"),

      ctx: $("#ctx"),
      ctxReply: $("#ctxReply"),
      ctxDelete: $("#ctxDelete"),

      modalBackdrop: $("#modalBackdrop"),
      settingsModal: $("#settingsModal"),
      modalClose: $("#modalClose"),
      openThemes: $("#openThemes"),
      openProfile: $("#openProfile"),
      settingsPane: $("#settingsPane"),
      paneThemes: $("#paneThemes"),
      paneProfile: $("#paneProfile"),
      paneUser: $("#paneUser"),

      myNick: $("#myNick"),
      myEmail: $("#myEmail"),
      myCreated: $("#myCreated"),
      myId: $("#myId"),
      myPhone: $("#myPhone"),
      editNick: $("#editNick"),
      addPhone: $("#addPhone"),

      otherNick: $("#otherNick"),
      otherEmail: $("#otherEmail"),
      otherCreated: $("#otherCreated"),
      otherId: $("#otherId"),
      otherPhone: $("#otherPhone"),

      callsLog: $("#callsLog"),
    };
  }

  // ---------- View switching ----------
  function setView(name) {
    const U = ui();
    const chats = U.viewChats;
    const calls = U.viewCalls;

    if (!chats || !calls) return;

    if (name === "calls") {
      chats.classList.remove("view-active");
      calls.classList.add("view-active");
      U.tabChats?.classList.remove("active");
      U.tabCalls?.classList.add("active");
    } else {
      calls.classList.remove("view-active");
      chats.classList.add("view-active");
      U.tabCalls?.classList.remove("active");
      U.tabChats?.classList.add("active");
    }
  }

  // ---------- Settings modal ----------
  function openModal() {
    const U = ui();
    U.modalBackdrop?.classList.remove("hidden");
    U.settingsModal?.classList.remove("hidden");
    // default to menu only (no pane)
    showPane(null);
  }
  function closeModal() {
    const U = ui();
    U.modalBackdrop?.classList.add("hidden");
    U.settingsModal?.classList.add("hidden");
  }

  function showPane(which) {
    const U = ui();
    [U.paneThemes, U.paneProfile, U.paneUser].forEach(p => p?.classList.add("hidden"));
    if (which === "themes") U.paneThemes?.classList.remove("hidden");
    if (which === "profile") U.paneProfile?.classList.remove("hidden");
    if (which === "user") U.paneUser?.classList.remove("hidden");
  }

  async function loadMyProfile() {
    const U = ui();
    const me = state.me;
    if (!me) return;

    const r = await api(`/api/profile?userId=${me.userId}`);
    const u = r.user;

    U.myNick.textContent = u.nickname || (me.nickname || "Без никнейма");
    U.myEmail.textContent = u.email;
    U.myCreated.textContent = fmtDate(u.created_at);
    U.myId.textContent = String(u.id);
    U.myPhone.textContent = u.phone ? u.phone : "—";
  }

  async function loadOtherProfile(otherId) {
    const U = ui();
    const r = await api(`/api/user?id=${otherId}`);
    const u = r.user;

    const nick = u.nickname ? u.nickname : "Пользователь без никнейма";
    U.otherNick.textContent = nick;
    U.otherEmail.textContent = u.email ? `Почта: ${u.email}` : "Данный пользователь не добавил почту.";
    U.otherCreated.textContent = u.created_at ? fmtDate(u.created_at) : "Данный пользователь не добавил дату.";
    U.otherId.textContent = String(u.id);
    U.otherPhone.textContent = u.phone ? u.phone : "Данный пользователь не добавил номер телефона.";

    state.activeOther = u;
  }

  // ---------- Dialogs ----------
  function dialogTitle(d) {
    const nick = d.nickname || "";
    if (nick.trim()) return nick;
    // show masked email
    const email = d.email || "";
    return email || `User ${d.other_id}`;
  }

  function renderDialogs() {
    const U = ui();
    const box = U.dialogs;
    if (!box) return;

    box.innerHTML = "";

    if (!state.dialogs.length) {
      const empty = document.createElement("div");
      empty.className = "soft-hint";
      empty.textContent = "Пока нет диалогов. Добавь пользователя по почте/ID и начни переписку.";
      box.appendChild(empty);
      return;
    }

    for (const d of state.dialogs) {
      const el = document.createElement("div");
      el.className = "dialog" + (state.activeOtherId === d.other_id ? " active" : "");
      el.dataset.otherId = String(d.other_id);

      const title = dialogTitle(d);
      const last = d.last_text ? plainFromHtml(d.last_text) : "";
      const when = d.last_created_at ? fmtDate(d.last_created_at) : "";

      el.innerHTML = `
        <div class="dialog-name"></div>
        <div class="dialog-sub"></div>
      `;
      el.querySelector(".dialog-name").textContent = title;
      el.querySelector(".dialog-sub").textContent = last ? `${last.slice(0, 38)}${last.length>38?"…":""} • ${when}` : `Без сообщений • ${when}`;

      if ((d.unread_count || 0) > 0) {
        const b = document.createElement("div");
        b.className = "badge";
        b.textContent = String(d.unread_count);
        el.appendChild(b);
      }

      el.addEventListener("click", () => {
        openDialog(d.other_id, d);
      });

      box.appendChild(el);
    }
  }

  async function fetchDialogs() {
    if (!state.me) return;
    const r = await api(`/api/dialogs?me=${state.me.userId}`);
    state.dialogs = r.dialogs || [];
    renderDialogs();
  }

  // ---------- Thread ----------
  function showChatArea(active) {
    const U = ui();
    if (!U.noChat || !U.threadWrap) return;

    if (!active) {
      U.noChat.classList.remove("hidden");
      U.threadWrap.classList.add("hidden");
      U.btnCall.disabled = true;
      U.btnOpenUserCard.disabled = true;
      U.chatWithName.textContent = "—";
      return;
    }

    U.noChat.classList.add("hidden");
    U.threadWrap.classList.remove("hidden");
    U.btnCall.disabled = false;
    U.btnOpenUserCard.disabled = false;
  }

  function renderThread() {
    const U = ui();
    const box = U.thread;
    if (!box) return;

    box.innerHTML = "";

    if (!state.thread.length) {
      U.emptyThread?.classList.remove("hidden");
    } else {
      U.emptyThread?.classList.add("hidden");
    }

    for (const m of state.thread) {
      const mine = m.sender_id === state.me.userId;
      const msg = document.createElement("div");
      msg.className = "msg" + (mine ? " me" : "");
      msg.dataset.mid = String(m.id);

      const textHtml = sanitizeHtml(m.text);
      const created = fmtDate(m.created_at);

      let replyBlock = "";
      if (m.reply_to_message_id) {
        const repText = m.reply_text ? plainFromHtml(m.reply_text) : "(сообщение не найдено)";
        replyBlock = `<div class="reply"><b>Ответ</b><div>${escapeHtml(repText).slice(0,120)}</div></div>`;
      }

      msg.innerHTML = `
        ${replyBlock}
        <div class="text"></div>
        <div class="meta"></div>
      `;

      msg.querySelector(".text").innerHTML = textHtml;
      msg.querySelector(".meta").textContent = created;

      // context menu
      msg.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openCtx(e.clientX, e.clientY, m);
      });

      box.appendChild(msg);
      state.knownMessageIds.add(m.id);
    }

    // scroll to bottom
    box.scrollTop = box.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function fetchThread(otherId) {
    const me = state.me.userId;
    const r = await api(`/api/messages/thread?me=${me}&with=${otherId}`);
    state.thread = (r.messages || []).map(x => ({
      ...x,
      text: x.text || ""
    }));
    renderThread();
  }

  async function openDialog(otherId, dialogRow) {
    state.activeOtherId = Number(otherId);
    showChatArea(true);

    const U = ui();
    // update title from dialog info immediately
    const title = dialogRow ? dialogTitle(dialogRow) : `ID ${otherId}`;
    U.chatWithName.textContent = title;

    renderDialogs();
    await loadOtherProfile(otherId).catch(() => { /* ignore */ });
    await fetchThread(otherId);
  }

  // ---------- Add user (only if exists) ----------
  let searchTimer = null;

  function clearSearchError() {
    const U = ui();
    U.searchError.textContent = "";
    U.searchError.classList.remove("show");
  }

  async function trySearchUser() {
    const U = ui();
    clearSearchError();

    const email = (U.searchEmail.value || "").trim().toLowerCase();
    const idStr = (U.searchId.value || "").trim();

    if (!email && !idStr) return;

    // We have only /api/users (list) right now -> find match
    const r = await api("/api/users");
    const users = r.users || [];

    let found = null;

    if (idStr) {
      const id = Number(idStr);
      if (id) found = users.find(u => Number(u.id) === id) || null;
    }
    if (!found && email) {
      found = users.find(u => (u.email || "").toLowerCase() === email) || null;
    }

    if (!found) {
      U.searchError.textContent = "Почта или айди введены неверно, никого не найдено";
      U.searchError.classList.add("show");
      return;
    }

    // Create dialog visually only after there are messages.
    // But we can open chat with this user so you can write first message.
    toast("Пользователь найден ✅", `${found.nickname || found.email} (id: ${found.id})`);
    await openDialog(found.id, { other_id: found.id, email: found.email, nickname: found.nickname, last_text:"", last_created_at:"", unread_count:0 });
  }

  function bindSearchInputs() {
    const U = ui();
    if (!U.searchEmail || !U.searchId) return;

    const onInput = () => {
      clearSearchError();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => trySearchUser().catch((e)=> {
        U.searchError.textContent = e.message;
        U.searchError.classList.add("show");
      }), 250);
    };

    U.searchEmail.addEventListener("input", onInput);
    U.searchId.addEventListener("input", onInput);
  }

  // ---------- Editor: smooth char animation ----------
  function setupEditor() {
    const U = ui();
    const ed = U.editor;
    if (!ed) return;

    // Wrap inserted text as spans to animate.
    // We'll intercept plain text paste & typing via input event.
    let lastHtml = ed.innerHTML;

    ed.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text/plain");
      insertAnimatedText(text);
    });

    function insertAnimatedText(text) {
      // Insert as spans at caret
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();

      const frag = document.createDocumentFragment();
      for (const ch of text) {
        if (ch === "\n") {
          frag.appendChild(document.createElement("br"));
          continue;
        }
        const span = document.createElement("span");
        span.className = "char";
        span.textContent = ch;
        frag.appendChild(span);
      }
      range.insertNode(frag);
      // move caret to end
      sel.collapseToEnd();
    }

    ed.addEventListener("beforeinput", (e) => {
      // For normal typing insert animated span
      if (e.inputType === "insertText" && e.data) {
        e.preventDefault();
        insertAnimatedText(e.data);
      }
      // allow delete/backspace
    });

    // selection toolbar
    const showFormatBarIfSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) { U.formatBar.classList.add("hidden"); return; }
      const isCollapsed = sel.isCollapsed;
      const inside = sel.anchorNode && ed.contains(sel.anchorNode);
      if (!inside) { U.formatBar.classList.add("hidden"); return; }
      if (isCollapsed) { U.formatBar.classList.add("hidden"); return; }
      U.formatBar.classList.remove("hidden");
    };

    document.addEventListener("selectionchange", showFormatBarIfSelection);

    // formatting
    U.formatBar?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-format]");
      if (!btn) return;
      const fmt = btn.dataset.format;
      try {
        document.execCommand(fmt, false, null);
      } catch {}
      ed.focus();
    });
  }

  function editorGetHtml() {
    const ed = ui().editor;
    if (!ed) return "";
    // keep only small tags (b,i,u,br,span,div)
    const html = sanitizeHtml(ed.innerHTML);
    return html.trim();
  }

  function editorClear() {
    const ed = ui().editor;
    if (!ed) return;
    ed.innerHTML = "";
  }

  // ---------- Reply ----------
  function setReply(msg) {
    state.replyTo = msg;
    const U = ui();
    if (!msg) {
      U.replyBox.classList.add("hidden");
      U.replyPreview.textContent = "";
      return;
    }
    U.replyBox.classList.remove("hidden");
    const txt = plainFromHtml(msg.text || "");
    U.replyPreview.textContent = txt.slice(0, 220);
  }

  // ---------- Send message ----------
  async function sendMessage() {
    if (!state.activeOtherId) {
      toast("Выбери диалог", "Сначала выбери пользователя слева");
      return;
    }
    const html = editorGetHtml();
    const plain = plainFromHtml(html);

    if (!plain) {
      toast("Пустое сообщение", "Напиши хоть что-то 🙂");
      return;
    }

    const payload = {
      senderId: state.me.userId,
      receiverId: state.activeOtherId,
      text: html,
      replyToMessageId: state.replyTo ? state.replyTo.id : null
    };

    await api("/api/messages/send", { method: "POST", body: JSON.stringify(payload) });
    editorClear();
    setReply(null);
  }

  // ---------- Context menu ----------
  let ctxMsg = null;

  function openCtx(x, y, msg) {
    const U = ui();
    ctxMsg = msg;

    const m = U.ctx;
    m.classList.remove("hidden");
    m.style.left = Math.min(x, window.innerWidth - 180) + "px";
    m.style.top = Math.min(y, window.innerHeight - 140) + "px";
  }

  function closeCtx() {
    const U = ui();
    ctxMsg = null;
    U.ctx.classList.add("hidden");
  }

  async function deleteMsg(msg) {
    if (!msg) return;
    // animate like Telegram
    const el = document.querySelector(`.msg[data-mid="${msg.id}"]`);
    if (el) el.classList.add("deleting");

    await sleep(160);
    await api(`/api/messages/${msg.id}?requesterId=${state.me.userId}`, { method: "DELETE" });
  }

  // ---------- WebSocket ----------
  function connectWS() {
    if (!state.me) return;
    const U = ui();

    try {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const wsUrl = `${proto}://${location.host}/ws?userId=${state.me.userId}`;
      const ws = new WebSocket(wsUrl);
      state.ws = ws;

      ws.onopen = () => {
        state.wsReady = true;
        if (U.topStatus) U.topStatus.textContent = "Онлайн";
      };

      ws.onclose = () => {
        state.wsReady = false;
        if (U.topStatus) U.topStatus.textContent = "Оффлайн (переподключение…)";
        setTimeout(connectWS, 1200);
      };

      ws.onmessage = async (ev) => {
        let data = null;
        try { data = JSON.parse(ev.data); } catch { return; }

        if (data.type === "ws:ready") {
          return;
        }

        if (data.type === "message:new") {
          const m = data.message;
          // If current thread matches, append and render fast
          const inThisDialog =
            (Number(m.sender_id) === state.activeOtherId && Number(m.receiver_id) === state.me.userId) ||
            (Number(m.sender_id) === state.me.userId && Number(m.receiver_id) === state.activeOtherId);

          // show toast if new message not in active dialog
          const fromOther = Number(m.sender_id) !== state.me.userId ? Number(m.sender_id) : Number(m.receiver_id);
          if (!inThisDialog && Number(m.sender_id) !== state.me.userId) {
            const last = state.lastToastByDialog.get(fromOther) || 0;
            const now = Date.now();
            if (now - last > 1200) {
              state.lastToastByDialog.set(fromOther, now);
              toast("Новое сообщение", "Пришло сообщение в другом чате");
            }
          }

          // refresh dialogs (unread badges)
          fetchDialogs().catch(()=>{});

          if (inThisDialog) {
            // fetch thread to keep reply join consistent
            await fetchThread(state.activeOtherId);
          }
        }

        if (data.type === "message:delete") {
          const id = Number(data.messageId);
          // remove from UI with animation if exists
          const el = document.querySelector(`.msg[data-mid="${id}"]`);
          if (el && !el.classList.contains("deleting")) el.classList.add("deleting");
          await sleep(180);

          // refresh thread
          if (state.activeOtherId) await fetchThread(state.activeOtherId);
          fetchDialogs().catch(()=>{});
        }

        if (data.type === "profile:update") {
          // if it's me -> reload my profile pane values
          if (Number(data.userId) === state.me.userId) {
            loadMyProfile().catch(()=>{});
          }
          fetchDialogs().catch(()=>{});
        }

        if (data.type && data.type.startsWith("call:")) {
          // demo calls
          const title = data.type === "call:incoming" ? "Входящий звонок" : "Звонок";
          toast(title, data.note || "—");
          addCallLog(data);
        }
      };
    } catch {
      // ignore
    }
  }

  function addCallLog(ev) {
    const U = ui();
    if (!U.callsLog) return;
    const item = document.createElement("div");
    item.className = "call-item";
    item.textContent = `${new Date().toLocaleTimeString("ru-RU")} • ${ev.type} • ${ev.note || ""}`;
    U.callsLog.prepend(item);
  }

  // ---------- Calls (demo) ----------
  async function startCall() {
    if (!state.activeOtherId) return;
    try {
      // if your server has /api/call/start — it will work; if not, just toast
      await api("/api/call/start", {
        method: "POST",
        body: JSON.stringify({ fromId: state.me.userId, toId: state.activeOtherId })
      });
      toast("Звонок", "Запрос на звонок отправлен (демо)");
    } catch {
      toast("Звонок (демо)", "Сервер ещё без звонков — сделаем дальше");
    }
  }

  // ---------- Init chat ----------
  async function initChat() {
    state.me = requireAuth();
    if (!state.me) return;

    const U = ui();

    // init theme
    initTheme();

    // fade
    setFadeIn();

    // logout
    U.btnLogout?.addEventListener("click", () => {
      store.clearAuth();
      location.href = "login.html";
    });

    // tabs
    U.tabChats?.addEventListener("click", () => setView("chats"));
    U.tabCalls?.addEventListener("click", () => setView("calls"));

    // settings
    U.btnSettings?.addEventListener("click", () => openModal());
    U.modalClose?.addEventListener("click", closeModal);
    U.modalBackdrop?.addEventListener("click", closeModal);

    U.openThemes?.addEventListener("click", () => showPane("themes"));
    U.openProfile?.addEventListener("click", async () => {
      showPane("profile");
      await loadMyProfile();
    });

    // theme chips
    $$(".chip[data-theme]").forEach(btn => {
      btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
    });

    // edit nickname
    U.editNick?.addEventListener("click", async () => {
      const current = (U.myNick.textContent || "").trim();
      const nn = prompt("Новый никнейм:", current === "—" ? "" : current);
      if (nn == null) return;
      try {
        const r = await api("/api/profile/nickname", {
          method: "POST",
          body: JSON.stringify({ userId: state.me.userId, nickname: nn })
        });
        toast("Никнейм обновлён ✅", r.nickname);
        await loadMyProfile();
        // also update local
        const me = store.get("fb_user", {});
        me.nickname = r.nickname;
        store.set("fb_user", me);
      } catch (e) {
        toast("Ошибка", e.message);
      }
    });

    // add phone
    U.addPhone?.addEventListener("click", async () => {
      const phone = prompt("Введите номер телефона:", "");
      if (phone == null) return;
      try {
        const r = await api("/api/profile/phone", {
          method: "POST",
          body: JSON.stringify({ userId: state.me.userId, phone })
        });
        toast("Телефон добавлен ✅", r.phone);
        await loadMyProfile();
      } catch (e) {
        toast("Ошибка", e.message);
      }
    });

    // open other user card by clicking name in chat header
    U.btnOpenUserCard?.addEventListener("click", async () => {
      if (!state.activeOtherId) return;
      openModal();
      showPane("user");
      try {
        await loadOtherProfile(state.activeOtherId);
      } catch (e) {
        toast("Ошибка", e.message);
      }
    });

    // calls
    U.btnCall?.addEventListener("click", startCall);

    // add user button -> just run search now
    U.btnAddUser?.addEventListener("click", () => {
      trySearchUser().catch(e => {
        U.searchError.textContent = e.message;
        U.searchError.classList.add("show");
      });
    });

    bindSearchInputs();

    // refresh
    U.btnRefresh?.addEventListener("click", async () => {
      await fetchDialogs();
      if (state.activeOtherId) await fetchThread(state.activeOtherId);
    });

    // done
    U.btnDone?.addEventListener("click", () => toast("Ок", "Готово 😄"));

    // editor
    setupEditor();

    // send
    U.btnSend?.addEventListener("click", () => {
      sendMessage().catch(e => toast("Ошибка", e.message));
    });

    // reply cancel
    U.replyCancel?.addEventListener("click", () => setReply(null));

    // ctx handlers
    document.addEventListener("click", (e) => {
      // close ctx if click outside
      const U2 = ui();
      if (!U2.ctx) return;
      if (!U2.ctx.classList.contains("hidden") && !U2.ctx.contains(e.target)) closeCtx();
    });
    document.addEventListener("scroll", closeCtx, true);
    window.addEventListener("resize", closeCtx);

    U.ctxReply?.addEventListener("click", () => {
      if (!ctxMsg) return;
      setReply(ctxMsg);
      closeCtx();
      ui().editor?.focus();
    });

    U.ctxDelete?.addEventListener("click", () => {
      if (!ctxMsg) return;
      deleteMsg(ctxMsg).catch(e => toast("Ошибка", e.message));
      closeCtx();
    });

    // start
    showChatArea(false);
    await fetchDialogs();
    connectWS();

    // auto refresh dialogs ~0.5s (как ты хотел)
    setInterval(() => {
      fetchDialogs().catch(()=>{});
    }, 500);
  }

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    setFadeIn();

    const page = document.body?.dataset?.page;
    if (page === "register") initRegister();
    if (page === "login") initLogin();
    if (page === "chat") initChat();
  });

})();