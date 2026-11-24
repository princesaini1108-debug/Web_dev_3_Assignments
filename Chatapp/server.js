// npm init -y, npm i express socket.io
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// ===================== NEW: extra imports =====================
const path = require("path");
const fs = require("fs");
const { db, save, uid } = require("./db"); // JSON database
const { createAuthRouter, requireAuth, getUserByToken, publicUser } = require("./auth"); // login/register
// ==============================================================

const app = express();
const httpserver = http.createServer(app);

const io = new Server(httpserver);

// ===================== NEW: express setup =====================
app.use(express.json({ limit: "100kb" })); // read JSON body (login/register forms)
app.use(express.static(path.join(__dirname, "public"))); // serve the frontend (index.html, css, js)
app.use("/uploads", express.static(path.join(__dirname, "data", "uploads"))); // chat images
app.use("/api", createAuthRouter(io)); // /api/register, /api/login, /api/logout, /api/profile
// ==============================================================

// To manage Active user count
let count = 0;

// ===================== NEW: helpers =====================
// userId -> number of open sockets (a user can open the app in 2 tabs)
const online = new Map();
const isOnline = (id) => online.has(id);
const withPresence = (u) => ({ ...publicUser(u), online: isOnline(u.id) });

// Chat ids:  "dm:<userA>:<userB>" (private chat)   |   "g:<groupId>" (group chat)
// Returns the list of user ids who belong to a chat ([] if chat is invalid)
function chatMembers(chatId) {
  if (typeof chatId !== "string") return [];
  if (chatId.startsWith("dm:")) {
    const ids = chatId.slice(3).split(":");
    const valid = ids.length === 2 && ids[0] !== ids[1] && ids.every((id) => db.users.some((u) => u.id === id));
    return valid ? ids : [];
  }
  if (chatId.startsWith("g:")) {
    const g = db.groups.find((x) => x.id === chatId.slice(2));
    return g ? g.members : [];
  }
  return [];
}

// Send "message ticks" update (delivered / read) to the sender of each message
function emitStatus(list) {
  list.forEach((m) =>
    io.to("user:" + m.from).emit("msg_status", { id: m.id, chatId: m.chatId, deliveredTo: m.deliveredTo, readBy: m.readBy })
  );
}

// When a user comes online, everything sent to him earlier becomes "delivered"
function markDelivered(userId) {
  const changed = [];
  db.messages.forEach((m) => {
    if (!m.system && m.from !== userId && !m.deliveredTo.includes(userId) && chatMembers(m.chatId).includes(userId)) {
      m.deliveredTo.push(userId);
      changed.push(m);
    }
  });
  if (changed.length) {
    save();
    emitStatus(changed);
  }
}

// Save a base64 image to data/uploads and return its public url
function saveImage(dataUrl) {
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!match) throw new Error("Unsupported image");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 900 * 1024) throw new Error("Image is too large (max 900 KB)");
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const name = uid() + "." + ext;
  fs.writeFileSync(path.join(__dirname, "data", "uploads", name), buffer);
  return "/uploads/" + name;
}

// GET /api/bootstrap -> everything the frontend needs after login (users, groups, old messages)
app.get("/api/bootstrap", requireAuth, (req, res) => {
  const me = req.user;
  const myGroups = new Set(db.groups.filter((g) => g.members.includes(me.id)).map((g) => g.id));
  const messages = db.messages.filter((m) =>
    m.chatId.startsWith("dm:") ? m.chatId.includes(me.id) : myGroups.has(m.chatId.slice(2))
  );
  res.json({
    me: publicUser(me),
    users: db.users.map(withPresence),
    groups: db.groups.filter((g) => myGroups.has(g.id)),
    messages,
  });
});

// Socket authentication: only logged-in users can connect
io.use((socket, next) => {
  const user = getUserByToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error("unauthorized"));
  socket.user = user;
  next();
});
// ========================================================

io.on("connection", (socket) => {
  const me = socket.user; // NEW: the logged-in user of this socket
  count++;
  console.log("Active User: ", count); // terminal/backend
  socket.emit("active", count); // frontend/client

  console.log("Connected Established");

  socket.emit("chat", "Hello from server side");

  // To broadcast a message
  socket.broadcast.emit("join", "New User Joined");

  socket.on("msg", (cb) => {
    console.log(cb);
  });

  // handling disconnect event
  socket.on("disconnect", () => {
    count--;
    console.log("Active User: ", count); // terminal/backend

    // ---------- NEW ----------
    socket.broadcast.emit("active", count); // refresh live count for everyone
    const left = (online.get(me.id) || 1) - 1;
    if (left <= 0) {
      online.delete(me.id);
      me.lastSeen = Date.now();
      save();
      io.emit("presence", { userId: me.id, online: false, lastSeen: me.lastSeen });
    } else online.set(me.id, left);
    // -------------------------
  });

  // For making announcement
  io.emit("announce", "Only 5hr class left");

  // ===================== NEW: chat features =====================
  socket.join("user:" + me.id); // personal room -> we can send to this user on all his tabs

  socket.broadcast.emit("active", count); // refresh live count for everyone

  // presence (online / offline)
  const wasOnline = isOnline(me.id);
  online.set(me.id, (online.get(me.id) || 0) + 1);
  if (!wasOnline) io.emit("presence", { userId: me.id, online: true, lastSeen: me.lastSeen });
  markDelivered(me.id);

  // ---- send a message (private or group) ----
  socket.on("send_message", (data, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    try {
      const { chatId, text, image, replyTo } = data || {};
      const members = chatMembers(chatId);
      if (!members.includes(me.id)) return reply({ ok: false, error: "You are not part of this chat" });

      const clean = String(text || "").trim().slice(0, 4000);
      const imageUrl = image ? saveImage(image) : null;
      if (!clean && !imageUrl) return reply({ ok: false, error: "Message is empty" });

      const quoted = replyTo && db.messages.find((m) => m.id === replyTo && m.chatId === chatId);
      const msg = {
        id: uid(),
        chatId,
        from: me.id,
        text: clean,
        image: imageUrl,
        replyTo: quoted ? quoted.id : null,
        time: Date.now(),
        deliveredTo: members.filter((id) => id !== me.id && isOnline(id)), // online users get it instantly
        readBy: [],
        reactions: {},
        deleted: false,
      };
      db.messages.push(msg);
      save();

      members.forEach((id) => io.to("user:" + id).emit("message", msg));
      reply({ ok: true, message: msg });
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
  });

  // ---- typing indicator ----
  socket.on("typing", ({ chatId, typing } = {}) => {
    const members = chatMembers(chatId);
    if (!members.includes(me.id)) return;
    members
      .filter((id) => id !== me.id)
      .forEach((id) => io.to("user:" + id).emit("typing", { chatId, userId: me.id, typing: !!typing }));
  });

  // ---- blue ticks: user opened the chat and read the messages ----
  socket.on("mark_read", ({ chatId } = {}) => {
    if (!chatMembers(chatId).includes(me.id)) return;
    const changed = [];
    db.messages.forEach((m) => {
      if (m.chatId === chatId && !m.system && m.from !== me.id && !m.readBy.includes(me.id)) {
        m.readBy.push(me.id);
        if (!m.deliveredTo.includes(me.id)) m.deliveredTo.push(me.id);
        changed.push(m);
      }
    });
    if (changed.length) {
      save();
      emitStatus(changed);
    }
  });

  // ---- delete for everyone (only the sender can do it) ----
  socket.on("delete_message", ({ id } = {}) => {
    const m = db.messages.find((x) => x.id === id);
    if (!m || m.from !== me.id || m.deleted) return;
    if (m.image) fs.unlink(path.join(__dirname, "data", "uploads", path.basename(m.image)), () => {});
    m.deleted = true;
    m.text = "";
    m.image = null;
    m.reactions = {};
    save();
    chatMembers(m.chatId).forEach((uidd) => io.to("user:" + uidd).emit("msg_deleted", { id: m.id, chatId: m.chatId }));
  });

  // ---- emoji reaction (click same emoji again to remove it) ----
  socket.on("react", ({ id, emoji } = {}) => {
    const m = db.messages.find((x) => x.id === id);
    if (!m || m.deleted || typeof emoji !== "string" || emoji.length > 8) return;
    if (!chatMembers(m.chatId).includes(me.id)) return;
    if (m.reactions[me.id] === emoji) delete m.reactions[me.id];
    else m.reactions[me.id] = emoji;
    save();
    chatMembers(m.chatId).forEach((uidd) =>
      io.to("user:" + uidd).emit("msg_reaction", { id: m.id, chatId: m.chatId, reactions: m.reactions })
    );
  });

  // ---- create a group ----
  socket.on("create_group", ({ name, members } = {}, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const title = String(name || "").trim();
    if (title.length < 2 || title.length > 30) return reply({ ok: false, error: "Group name must be 2-30 characters" });
    const ids = [...new Set([me.id, ...(Array.isArray(members) ? members : [])])].filter((id) =>
      db.users.some((u) => u.id === id)
    );
    if (ids.length < 2) return reply({ ok: false, error: "Select at least one person" });

    const colors = ["#0B7A75", "#C2410C", "#7C3AED", "#1D4ED8", "#BE185D", "#15803D"];
    const group = {
      id: uid(),
      name: title,
      about: "",
      members: ids,
      admin: me.id,
      color: colors[Math.floor(Math.random() * colors.length)],
      createdAt: Date.now(),
    };
    db.groups.push(group);
    const note = {
      id: uid(),
      chatId: "g:" + group.id,
      from: "system",
      system: true,
      text: me.name + " created group \u201c" + title + "\u201d",
      time: Date.now(),
      deliveredTo: [],
      readBy: [],
      reactions: {},
    };
    db.messages.push(note);
    save();
    ids.forEach((id) => {
      io.to("user:" + id).emit("group_created", group);
      io.to("user:" + id).emit("message", note);
    });
    reply({ ok: true, group });
  });
  // ==============================================================
});

httpserver.listen(8080, () => {
  console.log("Server started");
  console.log("Open http://localhost:8080 in your browser"); // NEW
});
