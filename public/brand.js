/* ===============================
   FroteBiteMessenger FRONT (FULL)
   Works with server.js endpoints:
   /api/register, /api/login, /api/profile,
   /api/profile/nickname, /api/profile/phone,
   /api/dialogs, /api/users/find,
   /api/messages/thread, /api/messages/send,
   DELETE /api/messages/:id
================================ */

const FB = (() => {
  const LS = {
    userId: "fb_userId",
    theme: "fb_theme",
    nickname: "fb_nickname",
    email: "fb_email"
  };

  function $(id){ return document.getElementById(id); }

  function setTheme(theme){
    const body = document.body;
    body.classList.remove("theme-ember","theme-sunset","theme-midnight","theme-aurora");
    body.classList.add(theme);
    localStorage.setItem(LS.theme, theme);
  }

  function getTheme(){
    return localStorage.getItem(LS.theme) || "theme-ember";
  }

  function escapeHtml(s){
    return String(s ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  // Allow basic b/i/u tags only (because formatting buttons wrap selection)
  function renderRichText(s){
    // escape first
    let x = escapeHtml(s);
    // allow only our simple tags if they exist as text
    x = x
      .replaceAll("&lt;b&gt;","<b>").replaceAll("&lt;/b&gt;","</b>")
      .replaceAll("&lt;i&gt;","<i>").replaceAll("&lt;/i&gt;","</i>")
      .replaceAll("&lt;u&gt;","<u>").replaceAll("&lt;/u&gt;","</u>");
    return x;
  }

  function fmtTime(iso){
    try{
      const d = new Date(iso);
      return d.toLocaleString();
    }catch{
      return String(iso||"");
    }
  }

  async function api(url, opts){
    const res = await fetch(url, opts);
    const data = await res.json().catch(()=> ({}));
    if(!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  function requireUserId(){
    const id = Number(localStorage.getItem(LS.userId));
    return id || 0;
  }

  function logout(){
    localStorage.removeItem(LS.userId);
    localStorage.removeItem(LS.nickname);
    localStorage.removeItem(LS.email);
    location.href = "login.html";
  }

  // ================= AUTH =================
  function initAuthPage(kind){
    setTheme(getTheme());

    if(kind === "register"){
      const form = $("registerForm");
      const err = $("regErr");
      $("toLogin").onclick = () => location.href = "login.html";

      form.onsubmit = async (e) => {
        e.preventDefault();
        err.textContent = "";
        const email = $("regEmail").value.trim();
        const password = $("regPass").value;

        try{
          await api("/api/register", {
            method:"POST",
            headers:{ "Content-Type":"application/json" },
            body: JSON.stringify({ email, password })
          });
          // auto go to login
          location.href = "login.html";
        }catch(ex){
          err.textContent = ex.message;
        }
      };
    }

    if(kind === "login"){
      const form = $("loginForm");
      const err = $("logErr");
      $("toRegister").onclick = () => location.href = "register.html";

      form.onsubmit = async (e) => {
        e.preventDefault();
        err.textContent = "";
        const email = $("logEmail").value.trim();
        const password = $("logPass").value;

        try{
          const r = await api("/api/login", {
            method:"POST",
            headers:{ "Content-Type":"application/json" },
            body: JSON.stringify({ email, password })
          });

          localStorage.setItem(LS.userId, String(r.user.id));
          localStorage.setItem(LS.email, r.user.email);
          localStorage.setItem(LS.nickname, r.user.nickname || "");
          location.href = "chat.html"; // <-- IMPORTANT, no loop
        }catch(ex){
          err.textContent = ex.message;
        }
      };
    }
  }

  // ================= CHAT =================
  function initChatPage(){
    setTheme(getTheme());
    const me = requireUserId();
    if(!me) return location.href = "login.html";

    // UI refs
    const dialogsEl = $("dialogs");
    const chatBody = $("chatBody");
    const emptyHint = $("emptyHint");
    const chatWithLabel = $("chatWithLabel");
    const modeLabel = $("modeLabel");
    const msgText = $("msgText");
    const findEmail = $("findEmail");
    const findId = $("findId");
    const findErr = $("findErr");
    const chatCard = $("chatCard");

    const toast = $("toast");
    const toastT1 = $("toastT1");
    const toastT2 = $("toastT2");

    const ctx = $("ctx");
    const ctxReply = $("ctxReply");
    const ctxDelete = $("ctxDelete");

    const settingsModal = $("settingsModal");
    const themesBlock = $("themesBlock");
    const profileBlock = $("profileBlock");
    const themeChips = $("themeChips");
    const profileInfo = $("profileInfo");
    const nicknameInput = $("nicknameInput");
    const phoneInput = $("phoneInput");
    const profileErr = $("profileErr");

    const userModal = $("userModal");
    const userInfo = $("userInfo");

    let currentWith = 0;
    let currentWithUser = null;
    let replyTo = null;
    let lastKnownDialogLastId = new Map(); // other_id -> last_id (for toast)

    // ---------- events ----------
    $("logoutBtn").onclick = logout;

    $("settingsBtn").onclick = () => {
      settingsModal.classList.add("show");
      themesBlock.style.display = "none";
      profileBlock.style.display = "none";
      profileErr.textContent = "";
    };
    $("closeSettings").onclick = () => settingsModal.classList.remove("show");
    settingsModal.addEventListener("click", (e)=> {
      if(e.target === settingsModal) settingsModal.classList.remove("show");
    });

    $("openThemes").onclick = () => {
      themesBlock.style.display = "block";
      profileBlock.style.display = "none";
      renderThemeChips();
    };

    $("openProfile").onclick = async () => {
      themesBlock.style.display = "none";
      profileBlock.style.display = "block";
      profileErr.textContent = "";
      await loadMyProfile();
    };

    $("closeUserModal").onclick = () => userModal.classList.remove("show");
    userModal.addEventListener("click", (e)=> {
      if(e.target === userModal) userModal.classList.remove("show");
    });

    $("refreshBtn").onclick = async () => {
      await refreshDialogs(true);
      if(currentWith) await loadThread(currentWith, true);
    };

    $("doneBtn").onclick = async () => {
      if(currentWith){
        await markReadCurrent();
        await refreshDialogs(true);
      }
    };

    $("sendBtn").onclick = async () => {
      await sendMessage();
    };

    // add by find
    $("addBtn").onclick = async () => {
      findErr.textContent = "";
      const email = findEmail.value.trim();
      const id = findId.value.trim();

      if(!email && !id){
        findErr.textContent = "Введите почту или ID";
        return;
      }

      try{
        const q = new URLSearchParams();
        if(email) q.set("email", email);
        if(id) q.set("id", id);
        const r = await api("/api/users/find?" + q.toString());
        // open dialog (it appears after first message anyway)
        openDialog(r.user);
      }catch(ex){
        findErr.textContent = "Почта или айди введены неверно, никого не найдено";
        animateError(findErr);
      }
    };

    // selection format bar
    msgText.addEventListener("mouseup", () => updateFormatBar());
    msgText.addEventListener("keyup", () => updateFormatBar());
    msgText.addEventListener("select", () => updateFormatBar());

    $("formatBar").addEventListener("click", (e)=> {
      const btn = e.target.closest("button[data-fmt]");
      if(!btn) return;
      applyFormat(btn.dataset.fmt);
      msgText.focus();
      updateFormatBar();
    });

    // tabs (chats / calls)
    $("tabChats").onclick = () => switchTab("chats");
    $("tabCalls").onclick = () => switchTab("calls");

    // call button
    $("callBtn").onclick = () => {
      if(!currentWith){
        showToast("Звонки", "Сначала выбери диалог 🙂", 2200);
        return;
      }
      showToast("Звонок", "Пока без звука. Идёт вызов…", 2500);
    };

    // click on header nickname -> open user profile modal
    chatWithLabel.onclick = async () => {
      if(!currentWithUser) return;
      await showUserProfile(currentWithUser.id);
    };

    // context menu close
    document.addEventListener("click", () => ctx.classList.remove("show"));
    window.addEventListener("scroll", () => ctx.classList.remove("show"), true);

    // initial
    renderThemeChips();
    refreshDialogs(true);
    setupWebSocket();

    // periodic refresh
    setInterval(async () => {
      await refreshDialogs(false);
      if(currentWith) await loadThread(currentWith, false);
    }, 500);

    // ---------- functions ----------
    function animateError(el){
      el.animate(
        [{transform:"translateX(0)"},{transform:"translateX(-6px)"},{transform:"translateX(6px)"},{transform:"translateX(0)"}],
        {duration:240, easing:"ease-out"}
      );
    }

    function renderThemeChips(){
      const themes = [
        {id:"theme-ember", name:"Ember"},
        {id:"theme-sunset", name:"Sunset"},
        {id:"theme-midnight", name:"Midnight"},
        {id:"theme-aurora", name:"Aurora"},
      ];
      themeChips.innerHTML = "";
      const active = getTheme();
      for(const t of themes){
        const b = document.createElement("div");
        b.className = "chip" + (t.id === active ? " active" : "");
        b.textContent = t.name;
        b.onclick = () => {
          setTheme(t.id);
          renderThemeChips();
        };
        themeChips.appendChild(b);
      }
    }

    async function loadMyProfile(){
      const r = await api("/api/profile?userId=" + me);
      const u = r.user;
      nicknameInput.value = u.nickname || "";
      phoneInput.value = u.phone || "";

      profileInfo.innerHTML = `
        <div><b>Почта</b> — ${escapeHtml(u.email)}</div>
        <div><b>ID</b> — ${escapeHtml(u.id)}</div>
        <div><b>Дата создания аккаунта</b> — ${escapeHtml(fmtTime(u.created_at))}</div>
        <div><b>Номер телефона</b> — ${u.phone ? escapeHtml(u.phone) : `<span style="color:rgba(255,255,255,.55)">— не добавлен</span>`}</div>
        <div><b>Никнейм</b> — ${u.nickname ? escapeHtml(u.nickname) : `<span style="color:rgba(255,255,255,.55)">— не задан</span>`}</div>
      `;

      $("saveNick").onclick = async () => {
        profileErr.textContent = "";
        try{
          const nn = nicknameInput.value.trim();
          const rr = await api("/api/profile/nickname", {
            method:"POST",
            headers:{ "Content-Type":"application/json" },
            body: JSON.stringify({ userId: me, nickname: nn })
          });
          localStorage.setItem(LS.nickname, rr.nickname);
          await loadMyProfile();
          showToast("Профиль", "Никнейм обновлён", 2200);
        }catch(ex){
          profileErr.textContent = ex.message;
          animateError(profileErr);
        }
      };

      $("savePhone").onclick = async () => {
        profileErr.textContent = "";
        try{
          const ph = phoneInput.value.trim();
          const rr = await api("/api/profile/phone", {
            method:"POST",
            headers:{ "Content-Type":"application/json" },
            body: JSON.stringify({ userId: me, phone: ph })
          });
          await loadMyProfile();
          showToast("Профиль", "Телефон сохранён", 2200);
        }catch(ex){
          profileErr.textContent = ex.message;
          animateError(profileErr);
        }
      };
    }

    async function showUserProfile(uid){
      const r = await api("/api/profile?userId=" + uid);
      const u = r.user;

      const phone = u.phone ? escapeHtml(u.phone) : `данный пользователь не добавил номер телефона.`;
      const nickname = u.nickname ? escapeHtml(u.nickname) : `данный пользователь не добавил никнейм.`;

      userInfo.innerHTML = `
        <div style="display:flex; gap:12px; align-items:center">
          <div style="width:62px;height:62px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.10);display:flex;align-items:center;justify-content:center;font-size:28px">👤</div>
          <div>
            <div style="font-weight:900;font-size:18px">${escapeHtml(u.email)}</div>
            <div style="color:rgba(255,255,255,.60);font-weight:800">ID: ${escapeHtml(u.id)}</div>
          </div>
        </div>
        <div style="margin-top:12px"><b>Дата создания аккаунта</b> — ${escapeHtml(fmtTime(u.created_at))}</div>
        <div style="margin-top:8px"><b>Телефон</b> — ${phone}</div>
        <div style="margin-top:8px"><b>Никнейм</b> — ${nickname}</div>
      `;

      userModal.classList.add("show");
    }

    function switchTab(tab){
      chatCard.classList.add("switching");
      setTimeout(()=> chatCard.classList.remove("switching"), 280);

      if(tab === "chats"){
        $("tabChats").classList.add("active");
        $("tabCalls").classList.remove("active");
        modeLabel.textContent = "Chats";
        // show main chat layout (already is)
      }else{
        $("tabCalls").classList.add("active");
        $("tabChats").classList.remove("active");
        modeLabel.textContent = "Calls";
        // calls mode - just toast for now (UI later)
        showToast("Звонки", "Вкладка готовится. Сейчас кнопка “Позвонить” работает как демо.", 3200);
      }
    }

    function openDialog(user){
      currentWith = user.id;
      currentWithUser = user;
      chatWithLabel.textContent = user.nickname ? `${user.nickname} (${user.email})` : user.email;
      loadThread(currentWith, true);
      refreshDialogs(true);
    }

    function setEmptyHint(on){
      emptyHint.style.display = on ? "block" : "none";
    }

    async function refreshDialogs(force){
      try{
        const r = await api("/api/dialogs?me=" + me);
        const dialogs = r.dialogs || [];

        // toast logic: if new message in another dialog
        for(const d of dialogs){
          const prev = lastKnownDialogLastId.get(d.other_id) || 0;
          if(d.last_id && d.last_id > prev){
            lastKnownDialogLastId.set(d.other_id, d.last_id);

            // if it is NOT current chat and last message from other -> toast
            if(d.other_id !== currentWith && d.last_sender_id === d.other_id){
              const title = "Новое сообщение";
              const who = d.nickname ? d.nickname : d.email;
              showToast(title, `${who}: ${d.last_text}`, 4000);
            }
          }
        }

        dialogsEl.innerHTML = "";

        if(dialogs.length === 0){
          const empty = document.createElement("div");
          empty.style.color = "rgba(255,255,255,.55)";
          empty.style.fontWeight = "900";
          empty.style.padding = "10px 6px";
          empty.textContent = "Пока нет диалогов. Добавь пользователя по почте или ID.";
          dialogsEl.appendChild(empty);
          return;
        }

        for(const d of dialogs){
          const el = document.createElement("div");
          el.className = "dialog" + (d.other_id === currentWith ? " active" : "");
          const who = d.nickname ? d.nickname : d.email;

          el.innerHTML = `
            <div class="top">
              <div class="who">${escapeHtml(who)}</div>
              <div class="meta">${escapeHtml(fmtTime(d.last_created_at))}</div>
            </div>
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
              <div style="color:rgba(255,255,255,.60);font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px">
                ${escapeHtml(d.last_text)}
              </div>
              ${d.unread_count > 0 ? `<div class="badge">${d.unread_count}</div>` : ``}
            </div>
          `;

          el.onclick = () => openDialog({ id: d.other_id, email: d.email, nickname: d.nickname });
          dialogsEl.appendChild(el);
        }
      }catch(e){
        // ignore
      }
    }

    async function loadThread(withUser, scrollToBottom){
      try{
        const r = await api(`/api/messages/thread?me=${me}&with=${withUser}`);
        const msgs = r.messages || [];

        chatBody.innerHTML = "";
        setEmptyHint(msgs.length === 0);

        for(const m of msgs){
          const node = renderMessage(m);
          chatBody.appendChild(node);
        }

        if(scrollToBottom) chatBody.scrollTop = chatBody.scrollHeight;

        // mark read if we are in this thread
        if(msgs.length){
          const lastId = msgs[msgs.length-1].id;
          await api("/api/read", {
            method:"POST",
            headers:{ "Content-Type":"application/json" },
            body: JSON.stringify({ userId: me, otherId: withUser, lastReadMessageId: lastId })
          }).catch(()=>{});
        }
      }catch(e){
        // ignore
      }
    }

    function renderMessage(m){
      const wrap = document.createElement("div");
      wrap.className = "msg " + (m.sender_id === me ? "me" : "");
      wrap.dataset.id = m.id;

      const replyHtml = m.reply_to_message_id ? `
        <div class="reply-preview">
          Ответ на #${escapeHtml(m.reply_to_message_id)}
          <span class="small">${escapeHtml(m.reply_text || "")}</span>
        </div>
      ` : "";

      wrap.innerHTML = `
        ${replyHtml}
        <div class="text">${renderRichText(m.text)}</div>
        <div class="time">${escapeHtml(fmtTime(m.created_at))} • id:${escapeHtml(m.id)}</div>
      `;

      // context menu
      wrap.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, m);
      });

      return wrap;
    }

    function showContextMenu(x, y, m){
      ctx.classList.add("show");
      ctx.style.left = x + "px";
      ctx.style.top = y + "px";

      ctxReply.onclick = () => {
        replyTo = m;
        showToast("Ответ", `Ответ на #${m.id}`, 1600);
        ctx.classList.remove("show");
        msgText.focus();
      };

      ctxDelete.onclick = async () => {
        ctx.classList.remove("show");
        await deleteMessage(m.id);
      };
    }

    async function deleteMessage(messageId){
      try{
        const node = chatBody.querySelector(`.msg[data-id="${messageId}"]`);
        if(node){
          node.classList.add("deleting");
          setTimeout(()=> node.remove(), 520);
        }
        await api(`/api/messages/${messageId}?requesterId=${me}`, { method:"DELETE" });
        showToast("Удалено", "Сообщение удалено для обоих", 1800);
      }catch(ex){
        showToast("Ошибка", ex.message, 2400);
      }
    }

    async function sendMessage(){
      if(!currentWith){
        showToast("Чаты", "Сначала выбери диалог слева 🙂", 2200);
        return;
      }
      const text = msgText.value.trim();
      if(!text) return;

      const payload = {
        senderId: me,
        receiverId: currentWith,
        text,
        replyToMessageId: replyTo ? replyTo.id : null
      };

      try{
        await api("/api/messages/send", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify(payload)
        });

        msgText.value = "";
        replyTo = null;

        // refresh
        await loadThread(currentWith, true);
        await refreshDialogs(true);
      }catch(ex){
        showToast("Ошибка", ex.message, 2600);
      }
    }

    async function markReadCurrent(){
      try{
        const last = chatBody.querySelector(".msg:last-child");
        if(!last) return;
        const mid = Number(last.dataset.id);
        if(!mid) return;
        await api("/api/read", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ userId: me, otherId: currentWith, lastReadMessageId: mid })
        });
      }catch{}
    }

    function showToast(t1, t2, ms){
      toast.classList.remove("fadeout");
      toast.classList.add("show");
      toastT1.textContent = t1;
      toastT2.textContent = t2;

      const bar = toast.querySelector(".bar > div");
      // restart animation
      bar.style.animation = "none";
      bar.offsetHeight; // reflow
      bar.style.animation = `toastBar ${Math.max(1500, ms||4000)}ms linear forwards`;

      setTimeout(() => {
        toast.classList.add("fadeout");
        setTimeout(()=> toast.classList.remove("show","fadeout"), 1500);
      }, ms || 4000);
    }

    function updateFormatBar(){
      const a = msgText.selectionStart;
      const b = msgText.selectionEnd;
      const has = (typeof a === "number" && typeof b === "number" && b > a);
      const bar = $("formatBar");
      if(has) bar.classList.add("show");
      else bar.classList.remove("show");
    }

    function applyFormat(kind){
      const a = msgText.selectionStart;
      const b = msgText.selectionEnd;
      if(b <= a) return;

      const before = msgText.value.slice(0, a);
      const sel = msgText.value.slice(a, b);
      const after = msgText.value.slice(b);

      const tagOpen = `<${kind}>`;
      const tagClose = `</${kind}>`;

      msgText.value = before + tagOpen + sel + tagClose + after;

      // set selection around same text
      const newStart = a + tagOpen.length;
      const newEnd = newStart + sel.length;
      msgText.setSelectionRange(newStart, newEnd);
    }

    function setupWebSocket(){
      // optional; if WS fails - app still works by polling
      try{
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/ws?userId=${me}`);
        ws.onmessage = async (e) => {
          try{
            const msg = JSON.parse(e.data);
            if(msg.type === "message:new"){
              const m = msg.message;
              // if message belongs to current thread -> reload thread
              if(currentWith && (m.sender_id === currentWith || m.receiver_id === currentWith)){
                await loadThread(currentWith, false);
              }
              await refreshDialogs(false);
            }
            if(msg.type === "message:delete"){
              const node = chatBody.querySelector(`.msg[data-id="${msg.messageId}"]`);
              if(node){
                node.classList.add("deleting");
                setTimeout(()=> node.remove(), 520);
              }
              await refreshDialogs(false);
            }
            if(msg.type === "profile:update"){
              // can refresh dialogs names
              await refreshDialogs(false);
            }
          }catch{}
        };
      }catch{}
    }
  }

  return { initAuthPage, initChatPage };
})();