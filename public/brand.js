// UI-only update layer (keeps your backend APIs as-is).
// If some API endpoints differ in your project, tell me what routes you use and I'll align it.

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  view: "chats",          // chats | calls
  theme: "ember",
  selectedUser: null,
  me: { email: "", id: "", nick: "" },
  toastTimer: null,
};

// Elements
const usersList = $("#usersList");
const usersEmpty = $("#usersEmpty");
const rightEmpty = $("#rightEmpty");
const chatWrap = $("#chatWrap");
const callsWrap = $("#callsWrap");
const chatTitle = $("#chatTitle");
const messagesEl = $("#messages");
const msgInput = $("#msgInput");
const formatBar = $("#formatBar");
const toast = $("#toast");
const toastText = $("#toastText");
const toastBarFill = $("#toastBarFill");
const searchEmail = $("#searchEmail");
const searchId = $("#searchId");
const searchErr = $("#searchErr");

// Theme switching
$$(".pill2").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".pill2").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    setTheme(btn.dataset.theme);
  });
});

function setTheme(theme) {
  state.theme = theme;
  document.body.className = `theme-${theme}`;
  // Persist
  localStorage.setItem("fb_theme", theme);
}

(function initTheme() {
  const saved = localStorage.getItem("fb_theme");
  if (saved) {
    setTheme(saved);
    const pill = $(`.pill2[data-theme="${saved}"]`);
    if (pill) {
      $$(".pill2").forEach(b => b.classList.remove("active"));
      pill.classList.add("active");
    }
  }
})();

// Bottom nav (blur switch)
$$(".navbtn").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".navbtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    setView(btn.dataset.view);
  });
});

function setView(view) {
  state.view = view;
  if (view === "calls") {
    callsWrap.hidden = false;
    chatWrap.hidden = true;
    rightEmpty.hidden = true;
    callsWrap.style.animation = "blurIn .22s ease-out";
  } else {
    callsWrap.hidden = true;
    // show chat only if selected user
    syncRightPane();
    chatWrap.style.animation = "blurIn .22s ease-out";
  }
}

function syncRightPane() {
  const hasChat = !!state.selectedUser;
  if (state.view !== "chats") return;

  if (!hasChat) {
    rightEmpty.hidden = true;   // user asked: "удали окно чата когда никто не выбран"
    chatWrap.hidden = true;
  } else {
    rightEmpty.hidden = true;
    chatWrap.hidden = false;
  }
}

// Profile modal
const modal = $("#modal");
$("#btnProfile").addEventListener("click", () => {
  $("#pEmail").textContent = state.me.email || "Ч";
  $("#pId").textContent = state.me.id || "Ч";
  $("#pNick").value = state.me.nick || "";
  modal.hidden = false;
});
$("#modalClose").addEventListener("click", () => (modal.hidden = true));
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.hidden = true;
});

$("#pSave").addEventListener("click", async () => {
  const nick = $("#pNick").value.trim();
  // Frontend-only: store locally (until backend supports it)
  state.me.nick = nick;
  localStorage.setItem("fb_nick", nick);
  modal.hidden = true;
  toastShow("Ќикнейм обновлЄн");
});

// Format bar: show when selecting text while typing
msgInput.addEventListener("mouseup", toggleFormatBar);
msgInput.addEventListener("keyup", toggleFormatBar);

function toggleFormatBar() {
  const start = msgInput.selectionStart;
  const end = msgInput.selectionEnd;
  const hasSelection = typeof start === "number" && typeof end === "number" && end > start;
  formatBar.hidden = !hasSelection;
}

$$(".fmt").forEach(btn => {
  btn.addEventListener("click", () => {
    const fmt = btn.dataset.fmt;
    applyFormat(fmt);
  });
});

function applyFormat(fmt) {
  const start = msgInput.selectionStart;
  const end = msgInput.selectionEnd;
  if (!(end > start)) return;

  const before = msgInput.value.slice(0, start);
  const sel = msgInput.value.slice(start, end);
  const after = msgInput.value.slice(end);

  // Simple markup: **bold**, _italic_, __underline__
  let wrapped = sel;
  if (fmt === "b") wrapped = `**${sel}**`;
  if (fmt === "i") wrapped = `_${sel}_`;
  if (fmt === "u") wrapped = `__${sel}__`;

  msgInput.value = before + wrapped + after;
  // restore cursor selection around wrapped text
  msgInput.focus();
  msgInput.selectionStart = start;
  msgInput.selectionEnd = start + wrapped.length;
  toggleFormatBar();
}

// Search/add user logic (UI). Backend check: youТll connect to your API.
$("#btnAdd").addEventListener("click", async () => {
  const email = searchEmail.value.trim();
  const id = searchId.value.trim();

  if (!email && !id) {
    searchErr.hidden = false;
    return;
  }

  // TODO: replace this stub with your real API call:
  // Example:
  // const res = await fetch(`/api/findUser?email=${encodeURIComponent(email)}&id=${encodeURIComponent(id)}`);
  // const data = await res.json();

  const found = await fakeFindUser(email, id);

  if (!found) {
    searchErr.hidden = false;
    animateShake(searchErr);
    return;
  }

  searchErr.hidden = true;
  addUserToList(found);
  searchEmail.value = "";
  searchId.value = "";
});

function animateShake(el) {
  el.animate(
    [{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }],
    { duration: 220, easing: "ease-out" }
  );
}

function addUserToList(user) {
  // remove empty state
  usersEmpty.style.display = "none";

  // avoid duplicates
  const existing = usersList.querySelector(`[data-uid="${user.id}"]`);
  if (existing) {
    existing.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const card = document.createElement("div");
  card.className = "user";
  card.dataset.uid = user.id;
  card.innerHTML = `
    <div class="user-name">${escapeHtml(user.nick || user.email || ("User " + user.id))}</div>
    <div class="user-sub">id: ${escapeHtml(String(user.id))}</div>
  `;
  card.addEventListener("click", () => selectUser(user, card));
  usersList.prepend(card);
}

function selectUser(user, cardEl) {
  state.selectedUser = user;
  $$(".user").forEach(u => u.classList.remove("active"));
  cardEl.classList.add("active");
  chatTitle.textContent = `ƒиалог: ${user.nick || user.email || ("id " + user.id)}`;
  state.view = "chats";
  $$(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === "chats"));
  callsWrap.hidden = true;
  syncRightPane();
  loadMessages();
}

// Messages (stub UI)
$("#btnRefresh").addEventListener("click", loadMessages);
$("#btnSend").addEventListener("click", sendMessage);

async function loadMessages() {
  if (!state.selectedUser) return;

  // Replace with your real API call
  // const res = await fetch(`/api/messages?with=${state.selectedUser.id}`);
  // const msgs = await res.json();

  const msgs = await fakeMessages(state.selectedUser.id);

  renderMessages(msgs);
}

function renderMessages(msgs) {
  messagesEl.innerHTML = "";
  msgs.forEach(m => {
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `
      <div class="msg-meta">${escapeHtml(m.time)}</div>
      <div class="msg-body">${renderMarkup(m.text)}</div>
    `;
    messagesEl.appendChild(div);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !state.selectedUser) return;

  msgInput.value = "";
  formatBar.hidden = true;

  // Replace with your real API call
  // await fetch("/api/send", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ to: state.selectedUser.id, text }) });

  await fakeSend(state.selectedUser.id, text);
  await loadMessages();
}

// Calls buttons
$("#btnCalls").addEventListener("click", () => {
  $$(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === "calls"));
  setView("calls");
});
$("#btnBackToChats").addEventListener("click", () => {
  $$(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === "chats"));
  setView("chats");
});

// Toast
function toastShow(text) {
  toastText.textContent = text;
  toast.hidden = false;

  // progress bar 1.5s and then fade out 1.5s
  toastBarFill.animate(
    [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
    { duration: 1500, easing: "linear", fill: "forwards" }
  );

  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1500, easing: "ease-out", fill: "forwards" });
    setTimeout(() => (toast.hidden = true), 1500);
  }, 1500);
}

// Init УmeФ from localStorage (until backend provides)
(function initMe() {
  state.me.nick = localStorage.getItem("fb_nick") || "";
  // If your app already stores email/id in localStorage, you can wire them here:
  // state.me.email = localStorage.getItem("userEmail") || "";
  // state.me.id = localStorage.getItem("userId") || "";
})();

// Hide empty chat window per request
syncRightPane();

// If no users yet, keep empty block visible
(function initUsersEmpty() {
  if (!usersList.children.length) usersEmpty.style.display = "";
})();

// ---- Helpers ----
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderMarkup(text) {
  // minimal safe markup: **bold**, _italic_, __underline__
  let t = escapeHtml(text);

  // underline __text__
  t = t.replace(/__([^_]+)__/g, "<u>$1</u>");
  // bold **text**
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  // italic _text_
  t = t.replace(/_([^_]+)_/g, "<i>$1</i>");

  return t;
}

// ---- Fake backend for UI demo (remove when wiring real API) ----
async function fakeFindUser(email, id) {
  await wait(160);
  const ok = (email && email.includes("@")) || (id && /^\d+$/.test(id));
  if (!ok) return null;
  return { id: id || String(Math.floor(Math.random() * 9000 + 1000)), email: email || `user${id}@mail.com`, nick: "" };
}

const FAKE = {};
async function fakeMessages(uid) {
  await wait(120);
  FAKE[uid] = FAKE[uid] || [
    { time: new Date().toLocaleString(), text: "ѕросто привет!" },
  ];
  return FAKE[uid];
}
async function fakeSend(uid, text) {
  await wait(80);
  FAKE[uid] = FAKE[uid] || [];
  FAKE[uid].push({ time: new Date().toLocaleString(), text });
  // simulate new message toast sometimes
  if (Math.random() < 0.25) toastShow("Ќовое сообщение (демо)");
}
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }