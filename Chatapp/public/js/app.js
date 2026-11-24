/* app.js - the chat application (dashboard, chat list, messages, socket events) */
(() => {
  "use strict";
  const { $, $$, esc, ic, store, api, toast } = G;

  /* =====================================================================
     STATE  (single source of truth; the UI is drawn from this object)
     ===================================================================== */
  const S = {
    me: null,
    users: {}, // id -> user
    groups: {}, // id -> group
    messages: {}, // chatId -> [messages sorted by time]
    activeChat: null,
    typing: {}, // chatId -> { userId: {t: timeout} }
    drafts: {}, // chatId -> unsent text
    filter: "all",
    query: "",
    reply: null, // message we are replying to
    live: 0, // "active" count coming from the server (original backend event)
    announce: null,
    newBelow: 0, // new messages while the user has scrolled up
    sound: store.get("sound", true),
  };
  let socket = null;
  let booted = false;
  let typingSent = false;
  let typingTimer = null;

  const dmId = (a, b) => "dm:" + [a, b].sort().join(":");
  const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

  /* =====================================================================
     SMALL HELPERS
     ===================================================================== */
  function avatar(entity, size = 44, dot = false) {
    const isGroup = Array.isArray(entity.members);
    const inner = isGroup ? ic("users") : esc(G.initials(entity.name));
    return `<span class="av" style="--s:${size}px;--c:${entity.color}">${inner}${dot && entity.online ? '<i class="dot"></i>' : ""}</span>`;
  }

  function chatInfo(chatId) {
    if (chatId.startsWith("g:")) {
      const g = S.groups[chatId.slice(2)];
      return g && { id: chatId, isGroup: true, name: g.name, entity: g, group: g };
    }
    const other = chatId.slice(3).split(":").find((i) => i !== S.me.id);
    const u = S.users[other];
    return u && { id: chatId, isGroup: false, name: u.name, entity: u, user: u };
  }

  const membersOf = (chatId) =>
    chatId.startsWith("g:") ? (S.groups[chatId.slice(2)] || {}).members || [] : chatId.slice(3).split(":");

  const lastMsg = (id) => (S.messages[id] || []).slice(-1)[0];
  const unreadCount = (id) =>
    (S.messages[id] || []).filter((m) => !m.system && m.from !== S.me.id && !m.readBy.includes(S.me.id)).length;
  const totalUnread = () => chatIds().reduce((n, id) => n + unreadCount(id), 0);
  const firstName = (u) => (u ? u.name.split(" ")[0] : "Someone");

  function chatIds() {
    const set = new Set(Object.keys(S.messages));
    Object.keys(S.groups).forEach((id) => set.add("g:" + id));
    return [...set].filter((id) => chatInfo(id));
  }

  function lastSeenText(u) {
    if (u.online) return "online";
    if (!u.lastSeen) return "offline";
    const d = G.dayDiff(u.lastSeen);
    if (d === 0) return "last seen today at " + G.time(u.lastSeen);
    if (d === 1) return "last seen yesterday at " + G.time(u.lastSeen);
    return "last seen " + new Date(u.lastSeen).toLocaleDateString([], { day: "numeric", month: "short" });
  }

  function typingText(chatId) {
    const ids = Object.keys(S.typing[chatId] || {});
    if (!ids.length) return "";
    if (!chatId.startsWith("g:")) return "typing...";
    if (ids.length === 1) return firstName(S.users[ids[0]]) + " is typing...";
    return ids.length + " people are typing...";
  }

  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  }

  function msgPreview(m) {
    if (m.deleted) return "This message was deleted";
    if (m.image) return "\uD83D\uDCF7 " + (m.text || "Photo");
    return m.text;
  }

  // sent -> single tick, delivered -> two grey ticks, read -> two blue ticks
  function statusOf(m) {
    if (m.pending) return "pending";
    const others = membersOf(m.chatId).filter((id) => id !== m.from);
    if (others.length && others.every((id) => m.readBy.includes(id))) return "read";
    if (m.deliveredTo.length || m.readBy.length) return "delivered";
    return "sent";
  }
  function tickIcon(m) {
    const s = statusOf(m);
    if (s === "pending") return ic("clock", "pend");
    if (s === "sent") return ic("check");
    return ic("ticks", s === "read" ? "read" : "");
  }

  function beep() {
    if (!S.sound) return;
    try {
      const ctx = (beep.ctx = beep.ctx || new (window.AudioContext || window.webkitAudioContext)());
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.2);
    } catch {}
  }

  function updateTitle() {
    const n = totalUnread();
    document.title = (n ? `(${n}) ` : "") + "Gupshup - Chat";
  }

  /* =====================================================================
     BOOT  (load data -> open socket)
     ===================================================================== */
  async function boot() {
    const data = await api("/bootstrap");
    S.me = data.me;
    S.users = {};
    data.users.forEach((u) => (S.users[u.id] = u));
    S.groups = {};
    data.groups.forEach((g) => (S.groups[g.id] = g));
    S.messages = {};
    data.messages.sort((a, b) => a.time - b.time).forEach((m) => (S.messages[m.chatId] = S.messages[m.chatId] || []).push(m));

    if (!booted) {
      booted = true;
      $("#auth").hidden = true;
      $("#app").hidden = false;
      bindUI();
      connectSocket();
    }
    renderAll();
    if (S.activeChat) markRead();
  }

  function connectSocket() {
    // Same connection style as the original client.html (websocket transport)
    socket = io({ transports: ["websocket"], auth: { token: G.token } });
    let first = true;

    socket.on("connect", () => {
      $("#net").hidden = true;
      socket.emit("msg", "Hello from client side"); // original line
      if (!first) boot().catch(() => {}); // after reconnect, re-sync missed messages
      first = false;
    });
    socket.on("disconnect", () => ($("#net").hidden = false));
    socket.on("connect_error", (err) => {
      if (err.message === "unauthorized") logout(true);
      else $("#net").hidden = false;
    });

    /* ----- events from the ORIGINAL backend ----- */
    socket.on("chat", (cb) => console.log(cb));
    socket.on("join", (cb) => toast(cb));
    socket.on("active", (n) => {
      S.live = n;
      renderStats();
    });
    socket.on("announce", (text) => {
      S.announce = text;
      renderDash();
    });

    /* ----- NEW events ----- */
    socket.on("message", (m) => {
      if (!addMessage(m)) return;
      const mine = m.from === S.me.id;
      if (!mine && !m.system) {
        const watching = S.activeChat === m.chatId && document.visibilityState === "visible";
        if (watching) markRead();
        else notify(m);
      }
      renderList();
      renderDash();
      updateTitle();
    });

    socket.on("msg_status", ({ id, chatId, deliveredTo, readBy }) => {
      const m = findMsg(id, chatId);
      if (!m) return;
      m.deliveredTo = deliveredTo;
      m.readBy = readBy;
      updateBubble(m);
      renderList();
    });

    socket.on("msg_deleted", ({ id, chatId }) => {
      const m = findMsg(id, chatId);
      if (!m) return;
      Object.assign(m, { deleted: true, text: "", image: null, reactions: {} });
      updateBubble(m);
      if (S.reply && S.reply.id === id) cancelReply();
      renderList();
    });

    socket.on("msg_reaction", ({ id, chatId, reactions }) => {
      const m = findMsg(id, chatId);
      if (!m) return;
      m.reactions = reactions;
      updateBubble(m);
    });

    socket.on("typing", ({ chatId, userId, typing }) => {
      const room = (S.typing[chatId] = S.typing[chatId] || {});
      if (room[userId]) clearTimeout(room[userId].t);
      if (typing) room[userId] = { t: setTimeout(() => stopTyping(chatId, userId), 4000) };
      else delete room[userId];
      refreshTyping(chatId);
    });

    socket.on("presence", ({ userId, online, lastSeen }) => {
      const u = S.users[userId];
      if (!u) return;
      u.online = online;
      u.lastSeen = lastSeen;
      renderList();
      renderDash();
      if (S.activeChat && membersOf(S.activeChat).includes(userId)) renderHeader();
    });

    socket.on("new_user", (u) => {
      S.users[u.id] = { ...u, online: false };
      renderDash();
    });
    socket.on("user_updated", (u) => {
      S.users[u.id] = { ...S.users[u.id], ...u };
      if (u.id === S.me.id) S.me = { ...S.me, ...u };
      renderAll();
    });
    socket.on("group_updated", (g) => {
      if (g.members.includes(S.me.id)) S.groups[g.id] = g;
      renderList();
      renderDash();
    });
    socket.on("group_created", (g) => {
      const fresh = !S.groups[g.id];
      S.groups[g.id] = g;
      if (fresh && g.admin !== S.me.id) toast(`You were added to "${g.name}"`);
      renderList();
      renderDash();
    });
  }

  function stopTyping(chatId, userId) {
    if (S.typing[chatId]) delete S.typing[chatId][userId];
    refreshTyping(chatId);
  }
  function refreshTyping(chatId) {
    renderList();
    if (S.activeChat === chatId) renderStatus();
  }

  function notify(m) {
    const c = chatInfo(m.chatId);
    if (!c) return;
    const sender = S.users[m.from];
    const title = c.isGroup ? `${c.name}: ${firstName(sender)}` : c.name;
    beep();
    if (document.visibilityState === "visible") toast(`${title}: ${msgPreview(m)}`);
    else if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body: msgPreview(m), tag: m.chatId });
  }

  /* =====================================================================
     RENDER: shell, sidebar, dashboard
     ===================================================================== */
  function renderAll() {
    $("#btn-profile").innerHTML = avatar(S.me, 42);
    renderTheme();
    renderList();
    renderDash();
    updateTitle();
    if (S.activeChat) {
      renderHeader();
      renderMsgs();
    }
  }

  function renderList() {
    const q = S.query.trim().toLowerCase();
    let items = chatIds().map((id) => ({ id, info: chatInfo(id), last: lastMsg(id), unread: unreadCount(id) }));

    // people with no conversation yet also show up while searching
    const extra = q
      ? Object.values(S.users)
          .filter((u) => u.id !== S.me.id && u.name.toLowerCase().includes(q) && !S.messages[dmId(S.me.id, u.id)])
          .map((u) => ({ id: dmId(S.me.id, u.id), info: chatInfo(dmId(S.me.id, u.id)), last: null, unread: 0 }))
      : [];

    items = items.filter((i) => {
      if (S.filter === "unread" && !i.unread) return false;
      if (S.filter === "groups" && !i.info.isGroup) return false;
      if (q && !i.info.name.toLowerCase().includes(q) && !(i.info.user && i.info.user.username.includes(q))) return false;
      return true;
    });
    if (S.filter === "all") items = items.concat(extra);
    items.sort((a, b) => ((b.last && b.last.time) || (b.info.group && b.info.group.createdAt) || 0) - ((a.last && a.last.time) || (a.info.group && a.info.group.createdAt) || 0));

    const list = $("#chat-list");
    if (!items.length) {
      const msg = q
        ? ["No results", "Try a different name."]
        : S.filter === "unread"
        ? ["No unread chats", "You are all caught up."]
        : ["No chats yet", "Tap + to start a conversation."];
      list.innerHTML = `<li class="empty-list"><b>${msg[0]}</b>${msg[1]}</li>`;
      return;
    }

    list.innerHTML = items
      .map(({ id, info, last, unread }) => {
        const typing = typingText(id);
        let prev = "";
        if (typing) prev = `<span class="ci-prev typing">${typing}</span>`;
        else if (last) {
          const mine = last.from === S.me.id;
          const who = last.system ? "" : mine ? "You: " : info.isGroup ? firstName(S.users[last.from]) + ": " : "";
          const tick = mine && !last.deleted && !last.system ? tickIcon(last) : "";
          prev = `<span class="ci-prev">${tick}<span>${esc(who + msgPreview(last))}</span></span>`;
        } else prev = `<span class="ci-prev">${info.isGroup ? "Group" : esc("@" + info.user.username)}</span>`;
        const time = last ? G.listTime(last.time) : "";
        return `<li class="ci ${id === S.activeChat ? "on" : ""} ${unread ? "unread" : ""}" data-chat="${id}" tabindex="0" role="button">
          ${avatar(info.entity, 48, !info.isGroup)}
          <div class="ci-body">
            <div class="ci-top"><span class="ci-name">${esc(info.name)}</span><span class="ci-time">${time}</span></div>
            <div class="ci-bot">${prev}${unread ? `<span class="badge">${unread > 99 ? "99+" : unread}</span>` : ""}</div>
          </div></li>`;
      })
      .join("");
  }

  const onlineUsers = () => Object.values(S.users).filter((u) => u.online && u.id !== S.me.id);

  function renderStats() {
    const unread = totalUnread();
    $("#st-live").textContent = S.live;
    $("#st-unread").textContent = unread;
    $("#st-unread-sub").textContent = unread ? "Waiting for your reply" : "All caught up";
    $("#st-people").textContent = Math.max(0, Object.keys(S.users).length - 1);
    $("#st-groups").textContent = Object.keys(S.groups).length;
    const n = onlineUsers().length;
    $("#foot-live").textContent = n ? `${n} ${n === 1 ? "person" : "people"} online` : "No one else online";
  }

  function renderDash() {
    renderStats();
    const h = new Date().getHours();
    const part = h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    $("#dash-hello").textContent = `${part}, ${firstName(S.me)}`;
    $("#dash-date").textContent = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

    const on = onlineUsers();
    $("#dash-online").innerHTML = on.length
      ? on
          .map((u) => `<li><button class="person" data-dm="${u.id}">${avatar(u, 40, true)}<span class="person-body"><span class="person-name">${esc(u.name)}</span><span class="person-sub">${esc(u.about || "@" + u.username)}</span></span>${ic("chat")}</button></li>`)
          .join("")
      : `<li class="muted-empty">Nobody else is online right now. Open the app in a second browser window, register another user and chat with yourself to see it live.</li>`;

    $("#dash-announce").hidden = !S.announce;
    $("#dash-announce-text").textContent = S.announce || "";
  }

  function renderTheme() {
    const dark = document.documentElement.dataset.theme === "dark";
    $("#btn-theme").innerHTML = ic(dark ? "sun" : "moon");
  }

  /* =====================================================================
     CHAT PANE
     ===================================================================== */
  function openChat(chatId) {
    if (!chatInfo(chatId)) return;
    if (S.activeChat) S.drafts[S.activeChat] = $("#msg-input").value;
    S.activeChat = chatId;
    S.newBelow = 0;
    cancelReply();
    $("#dash").hidden = true;
    $("#chat").hidden = false;
    $("#app").classList.add("chat-open");
    $("#emoji-panel").hidden = true;
    const input = $("#msg-input");
    input.value = S.drafts[chatId] || "";
    autosize();
    renderHeader();
    renderMsgs();
    markRead();
    renderList();
    if (matchMedia("(min-width: 821px)").matches) input.focus();
  }

  function closeChat() {
    if (S.activeChat) S.drafts[S.activeChat] = $("#msg-input").value;
    sendTyping(false);
    S.activeChat = null;
    $("#app").classList.remove("chat-open");
    $("#chat").hidden = true;
    $("#dash").hidden = false;
    renderList();
    renderDash();
  }

  function renderHeader() {
    const c = chatInfo(S.activeChat);
    if (!c) return;
    $("#head-who").innerHTML = `${avatar(c.entity, 42, !c.isGroup)}<span style="min-width:0;flex:1"><span class="head-name">${esc(c.name)}</span><span class="head-status" id="head-status"></span></span>`;
    renderStatus();
  }

  function renderStatus() {
    const c = chatInfo(S.activeChat);
    const el = $("#head-status");
    if (!c || !el) return;
    const typing = typingText(S.activeChat);
    let text;
    if (typing) text = typing;
    else if (c.isGroup) text = c.group.members.map((id) => (id === S.me.id ? "You" : firstName(S.users[id]))).join(", ");
    else text = lastSeenText(c.user);
    el.textContent = text;
    el.classList.toggle("on", !!typing || (!c.isGroup && c.user.online));
  }

  /* ---------- messages ---------- */
  const findMsg = (id, chatId) => (S.messages[chatId] || []).find((m) => m.id === id);

  function renderMsgs() {
    const box = $("#msgs");
    box.innerHTML = "";
    const list = S.messages[S.activeChat] || [];
    if (!list.length) {
      const c = chatInfo(S.activeChat);
      box.innerHTML = `<div class="start-note"><b>${c.isGroup ? "This group is quiet" : "No messages yet"}</b>Say hello to ${esc(c.isGroup ? "everyone" : c.name)} \uD83D\uDC4B</div>`;
      return;
    }
    let prev = null;
    list.forEach((m) => {
      if (!prev || G.dayKey(prev.time) !== G.dayKey(m.time)) box.append(sepEl(m.time));
      box.append(bubbleEl(m, prev));
      prev = m;
    });
    scrollBottom(false);
  }

  const sepEl = (t) => Object.assign(document.createElement("div"), { className: "sep", textContent: G.dayLabel(t) });

  function bubbleEl(m, prev, isNew = false) {
    const el = document.createElement("div");
    el.dataset.id = m.id;
    if (m.system) {
      el.className = "sys";
      el.textContent = m.text;
      return el;
    }
    const mine = m.from === S.me.id;
    const first = !prev || prev.from !== m.from || prev.system || G.dayKey(prev.time) !== G.dayKey(m.time);
    const isGroup = S.activeChat && S.activeChat.startsWith("g:");
    const sender = S.users[m.from];
    el.className = `row ${mine ? "out" : "in"} ${first ? "first" : ""} ${isNew ? "new" : ""}`;

    let quote = "";
    if (m.replyTo) {
      const q = findMsg(m.replyTo, m.chatId);
      const qs = q && S.users[q.from];
      quote = q
        ? `<button class="quote" data-goto="${q.id}" style="--qc:${q.from !== S.me.id && qs ? qs.color : "var(--brand)"}"><b>${q.from === S.me.id ? "You" : esc(qs ? qs.name : "")}</b><span>${esc(msgPreview(q))}</span></button>`
        : "";
    }

    let body;
    if (m.deleted) body = `<div class="del">${ic("ban")}${mine ? "You deleted this message" : "This message was deleted"}</div>`;
    else body = `${m.image ? `<img class="pic" src="${esc(m.image)}" alt="Photo" loading="lazy">` : ""}${m.text ? `<div class="txt">${linkify(m.text)}</div>` : ""}`;

    const reacts = Object.entries(m.reactions || {});
    const grouped = {};
    reacts.forEach(([uid, e]) => ((grouped[e] = grouped[e] || []).push(uid)));
    const reactHtml = Object.keys(grouped).length
      ? `<div class="reacts">${Object.entries(grouped)
          .map(([e, ids]) => `<button data-react-pill="${e}" class="${ids.includes(S.me.id) ? "mine" : ""}">${e}${ids.length > 1 ? " " + ids.length : ""}</button>`)
          .join("")}</div>`
      : "";

    el.innerHTML = `<div class="b">
        ${isGroup && !mine && first ? `<div class="who" style="--qc:${sender ? sender.color : "var(--brand)"}">${esc(sender ? sender.name : "Unknown")}</div>` : ""}
        ${quote}${body}
        <span class="meta">${G.time(m.time)}${mine && !m.deleted ? tickIcon(m) : ""}</span>
        ${!m.deleted && !m.pending ? `<button class="chev" aria-label="Message options">${ic("down")}</button>` : ""}
      </div>${reactHtml}`;
    return el;
  }

  function prevOf(m) {
    const arr = S.messages[m.chatId] || [];
    return arr[arr.indexOf(m) - 1] || null;
  }

  function updateBubble(m) {
    if (m.chatId !== S.activeChat) return;
    const old = $(`[data-id="${m.id}"]`, $("#msgs"));
    if (old) old.replaceWith(bubbleEl(m, prevOf(m)));
  }

  function addMessage(m) {
    const arr = (S.messages[m.chatId] = S.messages[m.chatId] || []);
    if (arr.some((x) => x.id === m.id)) return false;
    const last = arr[arr.length - 1];
    arr.push(m);
    if (last && m.time < last.time) arr.sort((a, b) => a.time - b.time);

    if (m.chatId === S.activeChat) {
      const stick = nearBottom() || m.from === S.me.id;
      if (arr[arr.length - 1] === m) {
        const box = $("#msgs");
        const note = $(".start-note", box);
        if (note) note.remove();
        if (!last || G.dayKey(last.time) !== G.dayKey(m.time)) box.append(sepEl(m.time));
        box.append(bubbleEl(m, last, true));
      } else renderMsgs();
      if (stick) scrollBottom(true);
      else if (m.from !== S.me.id) {
        S.newBelow++;
        updateFab();
      }
    }
    return true;
  }

  function removeMessage(id) {
    Object.values(S.messages).forEach((arr) => {
      const i = arr.findIndex((m) => m.id === id);
      if (i > -1) arr.splice(i, 1);
    });
    const el = $(`[data-id="${id}"]`, $("#msgs"));
    if (el) el.remove();
  }

  const nearBottom = () => {
    const b = $("#msgs");
    return b.scrollHeight - b.scrollTop - b.clientHeight < 140;
  };
  function scrollBottom(smooth) {
    const b = $("#msgs");
    b.scrollTo({ top: b.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    S.newBelow = 0;
    updateFab();
  }
  function updateFab() {
    const far = !nearBottom();
    $("#to-bottom").hidden = !far;
    const n = $("#to-bottom-n");
    n.hidden = !S.newBelow;
    n.textContent = S.newBelow;
  }

  function markRead() {
    if (!S.activeChat || !socket || document.visibilityState !== "visible") return;
    if (!unreadCount(S.activeChat)) return;
    socket.emit("mark_read", { chatId: S.activeChat });
    (S.messages[S.activeChat] || []).forEach((m) => {
      if (!m.system && m.from !== S.me.id && !m.readBy.includes(S.me.id)) m.readBy.push(S.me.id);
    });
    renderList();
    renderDash();
    updateTitle();
  }

  /* =====================================================================
     SENDING
     ===================================================================== */
  function dispatchSend(payload) {
    const tempId = "t" + Date.now() + Math.random().toString(36).slice(2, 6);
    // show the message immediately (clock icon) and replace it when the server confirms
    addMessage({
      id: tempId,
      chatId: payload.chatId,
      from: S.me.id,
      text: payload.text || "",
      image: payload.image || null,
      replyTo: payload.replyTo || null,
      time: Date.now(),
      deliveredTo: [],
      readBy: [],
      reactions: {},
      pending: true,
    });
    renderList();
    socket.emit("send_message", payload, (res) => {
      removeMessage(tempId);
      if (res && res.ok) addMessage(res.message);
      else toast((res && res.error) || "Message not sent", "error");
      renderList();
    });
  }

  function sendText() {
    const input = $("#msg-input");
    const text = input.value.trim();
    if (!text || !S.activeChat) return;
    dispatchSend({ chatId: S.activeChat, text, replyTo: S.reply ? S.reply.id : null });
    input.value = "";
    S.drafts[S.activeChat] = "";
    cancelReply();
    autosize();
    sendTyping(false);
    $("#emoji-panel").hidden = true;
    input.focus();
  }

  function autosize() {
    const t = $("#msg-input");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 140) + "px";
    $("#btn-send").disabled = !t.value.trim();
  }

  function sendTyping(on) {
    clearTimeout(typingTimer);
    if (!socket || !S.activeChat) return;
    if (on) {
      if (!typingSent) socket.emit("typing", { chatId: S.activeChat, typing: true });
      typingSent = true;
      typingTimer = setTimeout(() => sendTyping(false), 2000);
    } else if (typingSent) {
      socket.emit("typing", { chatId: S.activeChat, typing: false });
      typingSent = false;
    }
  }

  /* ---------- reply ---------- */
  function startReply(m) {
    S.reply = m;
    const u = S.users[m.from];
    $("#reply-body").innerHTML = `<b>${m.from === S.me.id ? "You" : esc(u ? u.name : "")}</b><span>${esc(msgPreview(m))}</span>`;
    $("#reply-bar").hidden = false;
    $("#msg-input").focus();
  }
  function cancelReply() {
    S.reply = null;
    $("#reply-bar").hidden = true;
  }

  /* ---------- image ---------- */
  function compressImage(file, max = 1280) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const r = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * r);
        const h = Math.round(img.height * r);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const x = c.getContext("2d");
        x.fillStyle = "#fff";
        x.fillRect(0, 0, w, h);
        x.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        let q = 0.8;
        let out = c.toDataURL("image/jpeg", q);
        while (out.length > 880000 && q > 0.3) out = c.toDataURL("image/jpeg", (q -= 0.1));
        out.length > 880000 ? reject(new Error("Image is too large")) : resolve(out);
      };
      img.onerror = () => reject(new Error("This file is not a valid image"));
      img.src = url;
    });
  }

  async function pickImage(file) {
    if (!file || !S.activeChat) return;
    try {
      const data = await compressImage(file);
      const chatId = S.activeChat;
      const m = openModal(`<header class="mh"><h2>Send photo</h2><button class="icon-btn" data-close aria-label="Close">${ic("x")}</button></header>
        <div class="mb"><img class="preview-img" src="${data}" alt="Preview"><input class="plain-input" id="cap" placeholder="Add a caption (optional)" maxlength="500"></div>
        <div class="mf"><button class="btn soft" data-close>Cancel</button><button class="btn primary" id="img-send">${ic("send")}Send</button></div>`);
      $("#cap", m.el).focus();
      const go = () => {
        dispatchSend({ chatId, text: $("#cap", m.el).value.trim(), image: data, replyTo: S.reply ? S.reply.id : null });
        cancelReply();
        m.close();
      };
      $("#img-send", m.el).onclick = go;
      $("#cap", m.el).onkeydown = (e) => e.key === "Enter" && go();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /* ---------- emoji ---------- */
  const EMOJI = {
    Smileys: "😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤔 🤨 😐 😶 🙄 😏 😴 😌 😔 😮 😲 😳 🥺 😢 😭 😤 😠 😡 🤯 😱 😰 🥵 🥶 🤗 🤭 🤫 😎 🤓 🥳",
    Gestures: "👍 👎 👌 ✌️ 🤞 🤟 🤘 👏 🙌 🙏 💪 👋 🤝 🫶 🤙 👀",
    Hearts: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💖 💯 🔥 ✨ ⭐ 🎉 🎊",
    Things: "📱 💻 📚 ✅ ❌ ⚡ 🚀 🎯 🎁 🍕 🍔 ☕ 🍰 ⚽ 🏏 🎵 🌹 🌞 🌙 🌈",
  };
  function toggleEmoji() {
    const p = $("#emoji-panel");
    if (!p.innerHTML)
      p.innerHTML = Object.entries(EMOJI)
        .map(([k, v]) => `<h4>${k}</h4><div class="emoji-grid">${v.split(" ").map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join("")}</div>`)
        .join("");
    p.hidden = !p.hidden;
    if (!p.hidden) $("#msg-input").focus();
  }
  function insertEmoji(e) {
    const t = $("#msg-input");
    const s = t.selectionStart ?? t.value.length;
    t.value = t.value.slice(0, s) + e + t.value.slice(t.selectionEnd ?? s);
    t.selectionStart = t.selectionEnd = s + e.length;
    t.focus();
    autosize();
    sendTyping(true);
  }

  /* =====================================================================
     OVERLAYS: menu, modal, lightbox
     ===================================================================== */
  function openMenu(m, anchor) {
    const menu = $("#menu");
    const mine = m.from === S.me.id;
    menu.innerHTML = `<div class="quick-react">${REACTIONS.map((e) => `<button data-mreact="${e}" aria-label="React ${e}">${e}</button>`).join("")}</div>
      <button class="item" data-mact="reply">${ic("reply")}Reply</button>
      ${m.text ? `<button class="item" data-mact="copy">${ic("copy")}Copy text</button>` : ""}
      ${mine ? `<button class="item danger" data-mact="delete">${ic("trash")}Delete for everyone</button>` : ""}`;
    menu.hidden = false;
    menu.dataset.id = m.id;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    let left = Math.min(Math.max(8, r.right - w), innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  const closeMenu = () => ($("#menu").hidden = true);

  function openModal(html) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const close = () => {
      root.innerHTML = "";
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    $(".backdrop", root).addEventListener("mousedown", (e) => e.target.classList.contains("backdrop") && close());
    $$("[data-close]", root).forEach((b) => (b.onclick = close));
    return { el: $(".modal", root), close };
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const m = openModal(`<header class="mh"><h2>${esc(title)}</h2></header><div class="mb"><p>${esc(text)}</p></div>
        <div class="mf"><button class="btn soft" data-close>Cancel</button><button class="btn danger" id="ok">${esc(okLabel)}</button></div>`);
      $("#ok", m.el).onclick = () => {
        m.close();
        resolve(true);
      };
      $$("[data-close]", m.el).forEach((b) => b.addEventListener("click", () => resolve(false)));
      $("#ok", m.el).focus();
    });
  }

  const personRow = (u, extra = "") =>
    `<li><button class="person" data-pick="${u.id}">${avatar(u, 40, true)}<span class="person-body"><span class="person-name">${esc(u.name)}</span><span class="person-sub">${esc(u.about || "@" + u.username)}</span></span>${extra}</button></li>`;

  function openNewChat() {
    const m = openModal(`<header class="mh"><h2>New chat</h2><button class="icon-btn" data-close aria-label="Close">${ic("x")}</button></header>
      <div class="search">${ic("search")}<input id="nc-q" placeholder="Search people" autocomplete="off"></div><ul class="people" id="nc-list"></ul>`);
    const draw = () => {
      const q = $("#nc-q", m.el).value.trim().toLowerCase();
      const list = Object.values(S.users)
        .filter((u) => u.id !== S.me.id && (u.name.toLowerCase().includes(q) || u.username.includes(q)))
        .sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
      $("#nc-list", m.el).innerHTML = list.length ? list.map((u) => personRow(u)).join("") : `<li class="muted-empty">No one found. Ask your friends to register first.</li>`;
    };
    draw();
    $("#nc-q", m.el).oninput = draw;
    $("#nc-q", m.el).focus();
    $("#nc-list", m.el).onclick = (e) => {
      const b = e.target.closest("[data-pick]");
      if (!b) return;
      m.close();
      openChat(dmId(S.me.id, b.dataset.pick));
    };
  }

  function openNewGroup() {
    const m = openModal(`<header class="mh"><h2>New group</h2><button class="icon-btn" data-close aria-label="Close">${ic("x")}</button></header>
      <div class="mb" style="padding-bottom:4px"><div><label class="lbl" for="g-name">Group name</label><input class="plain-input" id="g-name" maxlength="30" placeholder="Project team"></div><span class="lbl" style="margin:0">Add people</span></div>
      <ul class="people" id="g-list"></ul>
      <div class="mf"><button class="btn soft" data-close>Cancel</button><button class="btn primary" id="g-create">Create group</button></div>`);
    const users = Object.values(S.users).filter((u) => u.id !== S.me.id).sort((a, b) => a.name.localeCompare(b.name));
    $("#g-list", m.el).innerHTML = users.length
      ? users.map((u) => `<li><label class="person"><input type="checkbox" value="${u.id}">${avatar(u, 40)}<span class="person-body"><span class="person-name">${esc(u.name)}</span><span class="person-sub">@${esc(u.username)}</span></span></label></li>`).join("")
      : `<li class="muted-empty">No other users yet.</li>`;
    $("#g-name", m.el).focus();
    $("#g-create", m.el).onclick = () => {
      const name = $("#g-name", m.el).value.trim();
      const members = $$("input:checked", m.el).map((i) => i.value);
      if (name.length < 2) return toast("Enter a group name", "error");
      if (!members.length) return toast("Select at least one person", "error");
      socket.emit("create_group", { name, members }, (res) => {
        if (!res || !res.ok) return toast((res && res.error) || "Could not create group", "error");
        S.groups[res.group.id] = res.group;
        m.close();
        openChat("g:" + res.group.id);
      });
    };
  }

  function openInfo() {
    const c = chatInfo(S.activeChat);
    if (!c) return;
    let html;
    if (c.isGroup) {
      const rows = c.group.members.map((id) => S.users[id]).filter(Boolean).map((u) => personRow(u, u.id === S.me.id ? '<span class="person-sub">You</span>' : u.id === c.group.admin ? '<span class="person-sub">Admin</span>' : "")).join("");
      html = `<header class="mh"><h2>Group info</h2><button class="icon-btn" data-close aria-label="Close">${ic("x")}</button></header>
        <div class="mb"><div class="profile-top">${avatar(c.group, 84)}<h3>${esc(c.name)}</h3><p>${c.group.members.length} members</p></div></div>
        <ul class="people" id="info-list" style="padding-bottom:16px">${rows}</ul>`;
    } else {
      html = `<header class="mh"><h2>Contact info</h2><button class="icon-btn" data-close aria-label="Close">${ic("x")}</button></header>
        <div class="mb" style="padding-bottom:24px"><div class="profile-top">${avatar(c.user, 84, true)}<h3>${esc(c.name)}</h3><p>@${esc(c.user.username)}</p></div>
        <div><span class="lbl">About</span><p>${esc(c.user.about || "")}</p></div><div><span class="lbl">Status</span><p>${esc(lastSeenText(c.user))}</p></div></div>`;
    }
    const m = openModal(html);
    const list = $("#info-list", m.el);
    if (list)
      list.onclick = (e) => {
        const b = e.target.closest("[data-pick]");
        if (!b || b.dataset.pick === S.me.id) return;
        m.close();
        openChat(dmId(S.me.id, b.dataset.pick));
      };
  }

  function openProfile() {
    const dark = document.documentElement.dataset.theme === "dark";
    const notif = "Notification" in window ? Notification.permission : "denied";
    const m = openModal(`<header class="mh"><h2>Profile</h2><button class="icon-btn" data-close aria-label="Close">${ic("x")}</button></header>
      <div class="mb">
        <div class="profile-top">${avatar(S.me, 84)}<h3>${esc(S.me.name)}</h3><p>@${esc(S.me.username)}</p></div>
        <div><label class="lbl" for="p-name">Name</label><input class="plain-input" id="p-name" maxlength="30" value="${esc(S.me.name)}"></div>
        <div><label class="lbl" for="p-about">About</label><input class="plain-input" id="p-about" maxlength="80" value="${esc(S.me.about || "")}"></div>
        <div class="setting"><span>Dark mode</span><button class="toggle" id="t-dark" role="switch" aria-checked="${dark}" aria-label="Dark mode"></button></div>
        <div class="setting"><span>Message sound</span><button class="toggle" id="t-sound" role="switch" aria-checked="${S.sound}" aria-label="Message sound"></button></div>
        ${notif === "default" ? `<div class="setting"><span>Desktop notifications<small>Get alerts when this tab is in the background</small></span><button class="btn soft" id="t-notif">Enable</button></div>` : ""}
      </div>
      <div class="mf" style="justify-content:space-between"><button class="btn soft" id="p-logout">${ic("logout")}Log out</button><button class="btn primary" id="p-save">Save changes</button></div>`);

    $("#t-dark", m.el).onclick = (e) => {
      toggleTheme();
      e.currentTarget.setAttribute("aria-checked", document.documentElement.dataset.theme === "dark");
    };
    $("#t-sound", m.el).onclick = (e) => {
      S.sound = !S.sound;
      store.set("sound", S.sound);
      e.currentTarget.setAttribute("aria-checked", S.sound);
      if (S.sound) beep();
    };
    const nb = $("#t-notif", m.el);
    if (nb) nb.onclick = () => Notification.requestPermission().then(() => nb.closest(".setting").remove());
    $("#p-logout", m.el).onclick = () => logout();
    $("#p-save", m.el).onclick = async () => {
      try {
        const { user } = await api("/profile", { method: "PUT", body: { name: $("#p-name", m.el).value, about: $("#p-about", m.el).value } });
        S.me = { ...S.me, ...user };
        S.users[user.id] = { ...S.users[user.id], ...user };
        renderAll();
        m.close();
        toast("Profile updated");
      } catch (err) {
        toast(err.message, "error");
      }
    };
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
    renderTheme();
  }

  async function logout(silent) {
    try {
      if (!silent) await api("/logout", { method: "POST" });
    } catch {}
    store.del("token");
    if (socket) socket.disconnect();
    location.reload();
  }

  /* =====================================================================
     STATIC EVENT BINDINGS
     ===================================================================== */
  function bindUI() {
    // sidebar
    $("#btn-profile").onclick = openProfile;
    $("#btn-theme").onclick = toggleTheme;
    $("#btn-newchat").onclick = openNewChat;
    $("#btn-group").onclick = openNewGroup;
    $("#q-chat").onclick = openNewChat;
    $("#q-group").onclick = openNewGroup;
    $("#q-profile").onclick = openProfile;
    $("#chat-search").oninput = (e) => {
      S.query = e.target.value;
      renderList();
    };
    $$(".chip").forEach((c) =>
      c.addEventListener("click", () => {
        S.filter = c.dataset.filter;
        $$(".chip").forEach((x) => x.classList.toggle("on", x === c));
        renderList();
      })
    );
    const list = $("#chat-list");
    list.addEventListener("click", (e) => {
      const li = e.target.closest("[data-chat]");
      if (li) openChat(li.dataset.chat);
    });
    list.addEventListener("keydown", (e) => {
      const li = e.target.closest("[data-chat]");
      if (li && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        openChat(li.dataset.chat);
      }
    });
    $("#dash-online").addEventListener("click", (e) => {
      const b = e.target.closest("[data-dm]");
      if (b) openChat(dmId(S.me.id, b.dataset.dm));
    });

    // chat header
    $("#btn-back").onclick = closeChat;
    $("#head-who").onclick = openInfo;
    $("#btn-info").onclick = openInfo;

    // messages area
    const msgs = $("#msgs");
    msgs.addEventListener("scroll", updateFab, { passive: true });
    msgs.addEventListener("scroll", () => nearBottom() && (S.newBelow = 0), { passive: true });
    $("#to-bottom").onclick = () => scrollBottom(true);
    msgs.addEventListener("click", (e) => {
      const row = e.target.closest("[data-id]");
      if (!row) return;
      const m = findMsg(row.dataset.id, S.activeChat);
      if (!m) return;
      if (e.target.closest(".chev")) return openMenu(m, e.target.closest(".chev"));
      if (e.target.closest(".pic")) {
        $("#lightbox img").src = m.image;
        $("#lightbox").hidden = false;
        return;
      }
      const go = e.target.closest("[data-goto]");
      if (go) {
        const target = $(`[data-id="${go.dataset.goto}"]`, msgs);
        if (target) {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
          target.classList.add("flash");
          setTimeout(() => target.classList.remove("flash"), 1300);
        }
        return;
      }
      const pill = e.target.closest("[data-react-pill]");
      if (pill) socket.emit("react", { id: m.id, emoji: pill.dataset.reactPill });
    });
    msgs.addEventListener("contextmenu", (e) => {
      const b = e.target.closest(".b");
      const row = e.target.closest("[data-id]");
      if (!b || !row) return;
      const m = findMsg(row.dataset.id, S.activeChat);
      if (!m || m.deleted || m.pending) return;
      e.preventDefault();
      openMenu(m, { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) });
    });

    // message menu
    const menu = $("#menu");
    menu.addEventListener("click", async (e) => {
      const m = findMsg(menu.dataset.id, S.activeChat);
      closeMenu();
      if (!m) return;
      const react = e.target.closest("[data-mreact]");
      if (react) return socket.emit("react", { id: m.id, emoji: react.dataset.mreact });
      const act = e.target.closest("[data-mact]");
      if (!act) return;
      if (act.dataset.mact === "reply") startReply(m);
      if (act.dataset.mact === "copy") navigator.clipboard.writeText(m.text).then(() => toast("Copied"));
      if (act.dataset.mact === "delete" && (await confirmDialog("Delete message?", "This message will be removed for everyone in this chat.", "Delete"))) socket.emit("delete_message", { id: m.id });
    });
    document.addEventListener("mousedown", (e) => !menu.contains(e.target) && closeMenu());
    msgs.addEventListener("scroll", closeMenu, { passive: true });

    // composer
    const input = $("#msg-input");
    input.addEventListener("input", () => {
      autosize();
      sendTyping(!!input.value.trim());
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendText();
      }
    });
    $("#btn-send").onclick = sendText;
    $("#btn-emoji").onclick = toggleEmoji;
    $("#emoji-panel").addEventListener("click", (e) => {
      const b = e.target.closest("[data-emoji]");
      if (b) insertEmoji(b.dataset.emoji);
    });
    $("#btn-attach").onclick = () => $("#file").click();
    $("#file").onchange = (e) => {
      pickImage(e.target.files[0]);
      e.target.value = "";
    };
    $("#reply-x").onclick = cancelReply;
    input.addEventListener("paste", (e) => {
      const f = [...(e.clipboardData || {}).files || []].find((x) => x.type.startsWith("image/"));
      if (f) {
        e.preventDefault();
        pickImage(f);
      }
    });

    // lightbox + keyboard + visibility
    $("#lightbox").onclick = () => ($("#lightbox").hidden = true);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("#lightbox").hidden) $("#lightbox").hidden = true;
      else if (!$("#emoji-panel").hidden) $("#emoji-panel").hidden = true;
      else if (S.reply) cancelReply();
    });
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && markRead());
    window.addEventListener("focus", markRead);
  }

  /* =====================================================================
     START
     ===================================================================== */
  document.addEventListener("DOMContentLoaded", async () => {
    G.initAuth(boot);
    if (G.token) {
      try {
        await boot();
        return;
      } catch (err) {
        if (err.status === 401) {
          store.del("token");
          G.token = null;
        } else toast("Cannot reach the server", "error");
      }
    }
    $("#auth").hidden = false;
    $("#l-username").focus();
  });
})();
