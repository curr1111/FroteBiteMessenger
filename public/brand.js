const FB = (() => {
  const LS = {
    userId: "fb_userId",
    email: "fb_email",
    nickname: "fb_nickname",
    theme: "fb_theme"
  };

  const themes = ["theme-ember", "theme-sunset", "theme-midnight", "theme-aurora"];

  function $(id) {
    return document.getElementById(id);
  }

  function setTheme(theme) {
    const t = themes.includes(theme) ? theme : "theme-ember";
    themes.forEach(x => document.body.classList.remove(x));
    document.body.classList.add(t);
    localStorage.setItem(LS.theme, t);
  }

  function loadTheme() {
    setTheme(localStorage.getItem(LS.theme) || "theme-ember");
  }

  function nextTheme() {
    const current = localStorage.getItem(LS.theme) || "theme-ember";
    const index = themes.indexOf(current);
    const next = themes[(index + 1) % themes.length];
    setTheme(next);
  }

  function safeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function richText(s) {
    let x = safeHtml(s);
    x = x.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    x = x.replace(/__(.+?)__/g, "<u>$1</u>");
    x = x.replace(/_(.+?)_/g, "<i>$1</i>");
    x = x.replace(/\n/g, "<br>");
    return x;
  }

  async function api(url, opts) {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  function getUserId() {
    return Number(localStorage.getItem(LS.userId) || 0);
  }

  function showToast(title, text, duration = 4000) {
    const wrap = $("toastWrap");
    if (!wrap) return;

    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `
      <div class="toast-title">${safeHtml(title)}</div>
      <div class="toast-text">${safeHtml(text)}</div>
      <div class="toast-bar"></div>
    `;
    wrap.appendChild(el);

    setTimeout(() => {
      el.style.transition = "opacity .6s ease, transform .6s ease";
      el.style.opacity = "0";
      el.style.transform = "translateX(20px)";
      setTimeout(() => el.remove(), 700);
    }, duration);
  }

  function applyFormat(textarea, kind) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) return;

    const value = textarea.value;
    const selected = value.slice(start, end);

    let open = "";
    let close = "";

    if (kind === "bold") {
      open = "**";
      close = "**";
    } else if (kind === "italic") {
      open = "_";
      close = "_";
    } else if (kind === "underline") {
      open = "__";
      close = "__";
    }

    textarea.value = value.slice(0, start) + open + selected + close + value.slice(end);
    textarea.focus();
    textarea.selectionStart = start + open.length;
    textarea.selectionEnd = end + open.length;
  }

  // ---------------- auth ----------------
  function initAuthPage(kind) {
    loadTheme();

    const saved = getUserId();
    if (saved && kind === "login") {
      location.href = "chat.html";
      return;
    }

    if ($("themeBtn")) {
      $("themeBtn").addEventListener("click", nextTheme);
    }

    if (kind === "login") {
      $("toRegister").onclick = () => {
        location.href = "register.html";
      };

      $("loginForm").onsubmit = async (e) => {
        e.preventDefault();
        $("logErr").textContent = "";

        try {
          const email = $("logEmail").value.trim();
          const password = $("logPass").value;
          const r = await api("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
          });

          localStorage.setItem(LS.userId, String(r.user.id));
          localStorage.setItem(LS.email, r.user.email);
          localStorage.setItem(LS.nickname, r.user.nickname || "");
          location.href = "chat.html";
        } catch (e2) {
          $("logErr").textContent = e2.message;
        }
      };
    }

    if (kind === "register") {
      $("toLogin").onclick = () => {
        location.href = "login.html";
      };

      $("registerForm").onsubmit = async (e) => {
        e.preventDefault();
        $("regErr").textContent = "";

        try {
          const email = $("regEmail").value.trim();
          const password = $("regPass").value;
          await api("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
          });
          location.href = "login.html";
        } catch (e2) {
          $("regErr").textContent = e2.message;
        }
      };
    }
  }

  // ---------------- chat ----------------
  function initChatPage() {
    loadTheme();

    const me = getUserId();
    if (!me) {
      location.href = "login.html";
      return;
    }

    let ws = null;
    let currentTab = "chats";
    let currentDialogUser = null;
    let currentChannel = null;
    let currentReply = null;
    let currentContextMessage = null;

    const tabs = [...document.querySelectorAll(".bottom-tab")];
    const tabScreens = {
      calls: $("tab-calls"),
      chats: $("tab-chats"),
      channels: $("tab-channels"),
      profile: $("tab-profile")
    };

    const sectionTitle = $("sectionTitle");
    const dialogsList = $("dialogsList");
    const messagesList = $("messagesList");
    const messagesWrap = $("messagesWrap");
    const emptyChatState = $("emptyChatState");
    const callsList = $("callsList");
    const channelsList = $("channelsList");
    const channelPostsList = $("channelPostsList");
    const emptyChannelState = $("emptyChannelState");

    const messageInput = $("messageInput");
    const replyPreview = $("replyPreview");
    const formatBar = $("formatBar");

    const contextMenu = $("contextMenu");

    $("themeBtn").onclick = () => nextTheme();

    $("logoutBtn").onclick = () => {
      localStorage.removeItem(LS.userId);
      localStorage.removeItem(LS.email);
      localStorage.removeItem(LS.nickname);
      location.href = "login.html";
    };

    tabs.forEach(btn => {
      btn.onclick = () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
      };
    });

    function switchTab(tab) {
      currentTab = tab;
      tabs.forEach(x => x.classList.remove("active"));
      document.querySelector(`.bottom-tab[data-tab="${tab}"]`).classList.add("active");

      Object.values(tabScreens).forEach(x => x.classList.remove("active"));
      tabScreens[tab].classList.add("active");

      const titles = {
        calls: "Звонки",
        chats: "Чаты",
        channels: "Каналы",
        profile: "Мой профиль"
      };
      sectionTitle.textContent = titles[tab] || "Чаты";
    }

    // add user
    $("openAddUserBtn").onclick = () => {
      $("addUserBox").classList.remove("hidden");
    };
    $("closeAddUserBtn").onclick = () => {
      $("addUserBox").classList.add("hidden");
      $("findErr").textContent = "";
    };
    $("findUserBtn").onclick = async () => {
      $("findErr").textContent = "";
      try {
        const email = $("findEmail").value.trim();
        const id = $("findId").value.trim();

        let q = "";
        if (id) q = "?id=" + encodeURIComponent(id);
        else if (email) q = "?email=" + encodeURIComponent(email);
        else throw new Error("Введите почту или id");

        const r = await api("/api/users/find" + q);
        currentDialogUser = r.user;

        $("addUserBox").classList.add("hidden");
        switchTab("chats");
        await loadDialogs();
        await openDialog(r.user);
      } catch (e) {
        $("findErr").textContent = "Почта или айди введены неверно, никого не найдено";
      }
    };

    // message formatting
    messageInput.addEventListener("mouseup", updateFormatBar);
    messageInput.addEventListener("keyup", updateFormatBar);
    messageInput.addEventListener("select", updateFormatBar);

    formatBar.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const kind =
        btn.dataset.format === "bold" ? "bold" :
        btn.dataset.format === "italic" ? "italic" :
        "underline";
      applyFormat(messageInput, kind);
    });

    function updateFormatBar() {
      const show = messageInput.selectionStart !== messageInput.selectionEnd;
      formatBar.classList.toggle("hidden", !show);
    }

    $("refreshChatBtn").onclick = async () => {
      if (currentDialogUser) {
        await loadThread(currentDialogUser.id, true);
      }
      await loadDialogs();
      await loadCalls();
      await loadChannels();
    };

    $("sendMessageBtn").onclick = async () => {
      if (!currentDialogUser) {
        showToast("Чаты", "Сначала выбери диалог слева");
        return;
      }
      const text = messageInput.value.trim();
      if (!text) return;

      try {
        await api("/api/messages/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            senderId: me,
            receiverId: currentDialogUser.id,
            text,
            replyToMessageId: currentReply ? currentReply.id : null
          })
        });

        messageInput.value = "";
        currentReply = null;
        replyPreview.classList.add("hidden");
        replyPreview.innerHTML = "";

        await loadThread(currentDialogUser.id, true);
        await loadDialogs();
      } catch (e) {
        showToast("Ошибка", e.message);
      }
    };

    $("startCallBtn").onclick = async () => {
      if (!currentDialogUser) {
        showToast("Звонки", "Сначала выбери чат");
        return;
      }

      try {
        await api("/api/calls/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callerId: me,
            calleeId: currentDialogUser.id
          })
        });
        showToast("Звонок", `Пытаемся дозвониться до ${currentDialogUser.nickname || currentDialogUser.email}`);
        await loadCalls();
      } catch (e) {
        showToast("Ошибка", e.message);
      }
    };

    $("chatUserBtn").onclick = async () => {
      if (!currentDialogUser) return;
      switchTab("profile");
      await loadProfile(currentDialogUser.id, true);
    };

    $("channelTitleBtn").onclick = async () => {
      if (!currentChannel) return;
      showToast("Канал", currentChannel.title);
    };

    $("saveNicknameBtn").onclick = async () => {
      $("profileErr").textContent = "";
      try {
        const nickname = $("nicknameInput").value.trim();
        await api("/api/profile/nickname", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: me, nickname })
        });
        await loadProfile(me, false);
        showToast("Профиль", "Никнейм сохранён");
      } catch (e) {
        $("profileErr").textContent = e.message;
      }
    };

    $("savePhoneBtn").onclick = async () => {
      $("profileErr").textContent = "";
      try {
        const phone = $("phoneInput").value.trim();
        await api("/api/profile/phone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: me, phone })
        });
        await loadProfile(me, false);
        showToast("Профиль", "Телефон сохранён");
      } catch (e) {
        $("profileErr").textContent = e.message;
      }
    };

    // context menu
    document.addEventListener("click", () => {
      contextMenu.classList.add("hidden");
    });

    $("ctxReplyBtn").onclick = () => {
      if (!currentContextMessage) return;
      currentReply = currentContextMessage;
      replyPreview.classList.remove("hidden");
      replyPreview.innerHTML = `<b>Ответ на сообщение:</b><br>${richText(currentContextMessage.text)}`;
      contextMenu.classList.add("hidden");
      messageInput.focus();
    };

    $("ctxDeleteBtn").onclick = async () => {
      if (!currentContextMessage) return;
      contextMenu.classList.add("hidden");

      try {
        await api(`/api/messages/${currentContextMessage.id}?requesterId=${me}`, {
          method: "DELETE"
        });

        const node = messagesList.querySelector(`[data-mid="${currentContextMessage.id}"]`);
        if (node) node.classList.add("deleting");
        setTimeout(async () => {
          if (currentDialogUser) await loadThread(currentDialogUser.id, false);
          await loadDialogs();
        }, 350);
      } catch (e) {
        showToast("Ошибка", e.message);
      }
    };

    async function loadDialogs() {
      const r = await api(`/api/dialogs?me=${me}`);
      dialogsList.innerHTML = "";

      if (!r.dialogs.length) {
        dialogsList.innerHTML = `<div class="muted">Пока нет активных диалогов. Добавь пользователя.</div>`;
        return;
      }

      for (const d of r.dialogs) {
        const el = document.createElement("div");
        el.className = "dialog-item" + (currentDialogUser && currentDialogUser.id === d.other_id ? " active" : "");
        el.innerHTML = `
          <div class="dialog-top">
            <div class="dialog-name">${safeHtml(d.nickname || d.email)}</div>
            ${d.unread_count ? `<div class="dialog-badge">${d.unread_count}</div>` : `<div class="muted">${new Date(d.last_created_at).toLocaleTimeString()}</div>`}
          </div>
          <div class="dialog-preview">${safeHtml(d.last_text || "")}</div>
        `;
        el.onclick = async () => {
          currentDialogUser = {
            id: d.other_id,
            email: d.email,
            nickname: d.nickname || ""
          };
          await openDialog(currentDialogUser);
        };
        dialogsList.appendChild(el);
      }
    }

    async function openDialog(user) {
      $("chatUserBtn").textContent = user.nickname || user.email;
      $("chatSubInfo").textContent = `ID: ${user.id}`;
      emptyChatState.classList.add("hidden");
      await loadThread(user.id, true);
      await loadDialogs();
    }

    async function loadThread(withUser, scrollBottom = false) {
      const r = await api(`/api/messages/thread?me=${me}&with=${withUser}`);
      messagesList.innerHTML = "";

      if (!r.messages.length) {
        emptyChatState.classList.remove("hidden");
        emptyChatState.innerHTML = `
          <div class="empty-title">В данном чате пока что нет сообщений</div>
          <div class="empty-text">Начните первыми разговор</div>
        `;
        return;
      }

      emptyChatState.classList.add("hidden");

      for (const m of r.messages) {
        const el = document.createElement("div");
        el.className = "message" + (m.sender_id === me ? " me" : "");
        el.dataset.mid = m.id;

        const replyHtml = m.reply_to_message_id
          ? `<div class="message-reply">Ответ на: ${richText(m.reply_text || "")}</div>`
          : "";

        el.innerHTML = `
          ${replyHtml}
          <div class="message-text">${richText(m.text)}</div>
          <div class="message-meta">${new Date(m.created_at).toLocaleString()} • id:${m.id}</div>
        `;

        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          currentContextMessage = m;
          contextMenu.style.left = e.clientX + "px";
          contextMenu.style.top = e.clientY + "px";
          contextMenu.classList.remove("hidden");
        });

        messagesList.appendChild(el);
      }

      const last = r.messages[r.messages.length - 1];
      if (last) {
        await api("/api/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: me,
            otherId: withUser,
            lastReadMessageId: last.id
          })
        }).catch(() => {});
      }

      if (scrollBottom) {
        messagesWrap.scrollTop = messagesWrap.scrollHeight;
      }
    }

    async function loadChannels() {
      const r = await api("/api/channels");
      channelsList.innerHTML = "";

      for (const ch of r.channels) {
        const el = document.createElement("div");
        el.className = "channel-item" + (currentChannel && currentChannel.id === ch.id ? " active" : "");
        el.innerHTML = `
          <div class="channel-name">${safeHtml(ch.title)}</div>
          <div class="channel-desc">${safeHtml(ch.description || "")}</div>
        `;
        el.onclick = async () => {
          currentChannel = ch;
          $("channelTitleBtn").textContent = ch.title;
          $("channelSubInfo").textContent = ch.is_read_only ? "Только чтение" : "Обычный канал";
          await loadChannelPosts(ch.id);
          await loadChannels();
        };
        channelsList.appendChild(el);
      }
    }

    async function loadChannelPosts(channelId) {
      const r = await api(`/api/channels/${channelId}/posts`);
      channelPostsList.innerHTML = "";

      if (!r.posts.length) {
        emptyChannelState.classList.remove("hidden");
        return;
      }

      emptyChannelState.classList.add("hidden");

      for (const p of r.posts) {
        const el = document.createElement("div");
        el.className = "channel-post";
        el.innerHTML = `
          <div class="channel-post-title">${safeHtml(p.title || "Публикация")}</div>
          <div class="channel-post-body">${richText(p.body)}</div>
          <div class="channel-post-meta">${new Date(p.created_at).toLocaleString()}</div>
        `;
        channelPostsList.appendChild(el);
      }
    }

    async function loadCalls() {
      const r = await api(`/api/calls?userId=${me}`);
      callsList.innerHTML = "";

      if (!r.calls.length) {
        callsList.innerHTML = `<div class="muted">Пока вызовов нет.</div>`;
        return;
      }

      for (const c of r.calls) {
        const isCaller = c.caller_id === me;
        const otherName = isCaller
          ? (c.callee_nickname || c.callee_email)
          : (c.caller_nickname || c.caller_email);

        const el = document.createElement("div");
        el.className = "call-item";
        el.innerHTML = `
          <div class="call-top">
            <div class="call-name">${safeHtml(otherName)}</div>
            <div class="muted">${new Date(c.created_at).toLocaleString()}</div>
          </div>
          <div class="call-desc">${isCaller ? "Исходящий" : "Входящий"} • ${safeHtml(c.status)}</div>
        `;
        callsList.appendChild(el);
      }
    }

    async function loadProfile(userId = me, foreign = false) {
      const r = await api(`/api/profile?userId=${userId}`);
      const u = r.user;

      if (foreign) {
        showToast("Профиль пользователя", `${u.nickname || "Без никнейма"} • ${u.email}`);
        return;
      }

      $("profileId").textContent = u.id;
      $("profileEmail").textContent = u.email;
      $("profileCreated").textContent = new Date(u.created_at).toLocaleString();
      $("profilePhoneText").textContent = u.phone || "—";
      $("nicknameInput").value = u.nickname || "";
      $("phoneInput").value = u.phone || "";
    }

    function setupWebSocket() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws?userId=${me}`);

      ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);

        if (msg.type === "message:new") {
          const m = msg.message;
          const belongs =
            currentDialogUser &&
            ((m.sender_id === currentDialogUser.id && m.receiver_id === me) ||
             (m.receiver_id === currentDialogUser.id && m.sender_id === me));

          if (belongs) {
            await loadThread(currentDialogUser.id, true);
          } else if (m.sender_id !== me) {
            showToast("Новое сообщение", "Пришло новое сообщение");
          }

          await loadDialogs();
        }

        if (msg.type === "message:delete") {
          const node = messagesList.querySelector(`[data-mid="${msg.messageId}"]`);
          if (node) node.classList.add("deleting");
          setTimeout(async () => {
            if (currentDialogUser) await loadThread(currentDialogUser.id, false);
            await loadDialogs();
          }, 340);
        }

        if (msg.type === "profile:update") {
          await loadDialogs();
          if (currentTab === "profile") {
            await loadProfile(me, false);
          }
        }

        if (msg.type === "channel:newpost") {
          showToast("Канал", msg.post.title || "Новое обновление");
          if (currentChannel && currentChannel.id === msg.channelId) {
            await loadChannelPosts(msg.channelId);
          }
        }

        if (msg.type === "call:new") {
          const c = msg.call;
          if (c.caller_id !== me) {
            showToast("Входящий вызов", "Тебе звонят");
          }
          await loadCalls();
        }
      };
    }

    // init
    setupWebSocket();
    loadDialogs();
    loadChannels();
    loadCalls();
    loadProfile(me, false);
    switchTab("chats");
  }

  return {
    initAuthPage,
    initChatPage
  };
})();