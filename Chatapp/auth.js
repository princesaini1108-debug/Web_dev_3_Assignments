// auth.js  (NEW)
// Register / Login / Logout / Profile  ->  REST APIs (normal HTTP)
// Passwords are NEVER stored as plain text. We use Node's built-in
// crypto.scrypt (salted hash), so no extra npm package is needed.
const crypto = require("crypto");
const express = require("express");
const { db, save, uid } = require("./db");

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // login stays valid for 30 days
const COLORS = ["#0B7A75", "#C2410C", "#7C3AED", "#B45309", "#BE185D", "#1D4ED8", "#15803D", "#0E7490", "#B91C1C", "#6D28D9"];

/* ---------- password helpers ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, user) {
  const attempt = crypto.scryptSync(password, user.salt, 64);
  const stored = Buffer.from(user.hash, "hex");
  return stored.length === attempt.length && crypto.timingSafeEqual(attempt, stored);
}

/* ---------- session (token) helpers ---------- */
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[token] = { userId, createdAt: Date.now() };
  save();
  return token;
}
function getUserByToken(token) {
  const s = db.sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    delete db.sessions[token];
    save();
    return null;
  }
  return db.users.find((u) => u.id === s.userId) || null;
}
// Express middleware -> protects private routes
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: "Please log in again" });
  req.user = user;
  req.token = token;
  next();
}

// Only safe fields are sent to the browser (never the password hash)
function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, about: u.about, color: u.color, lastSeen: u.lastSeen };
}

/* ---------- very small brute-force protection ---------- */
const attempts = new Map();
const WINDOW = 5 * 60 * 1000;
function isBlocked(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW) {
    attempts.delete(key);
    return false;
  }
  return a.count >= 5;
}
function addFail(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}

/* ---------- routes ---------- */
function createAuthRouter(io) {
  const router = express.Router();

  // POST /api/register
  router.post("/register", (req, res) => {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (name.length < 2 || name.length > 30) return res.status(400).json({ error: "Name must be 2-30 characters" });
    if (!/^[a-z0-9_]{3,20}$/.test(username))
      return res.status(400).json({ error: "Username: 3-20 letters, numbers or underscore" });
    if (password.length < 6 || password.length > 100)
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (db.users.some((u) => u.username === username)) return res.status(409).json({ error: "This username is already taken" });

    const { salt, hash } = hashPassword(password);
    const user = {
      id: uid(),
      username,
      name,
      salt,
      hash,
      about: "Hey there! I am using Gupshup.",
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    db.users.push(user);

    // every new user joins the default "Everyone" group
    const everyone = db.groups.find((g) => g.id === "everyone");
    everyone.members.push(user.id);
    save();

    // tell already-connected users that someone new registered
    io.emit("new_user", publicUser(user));
    everyone.members.forEach((id) => io.to("user:" + id).emit("group_updated", everyone));

    res.json({ token: createSession(user.id), user: publicUser(user) });
  });

  // POST /api/login
  router.post("/login", (req, res) => {
    const body = req.body || {};
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "").slice(0, 100);
    const key = req.ip + ":" + username;

    if (isBlocked(key)) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes" });

    const user = db.users.find((u) => u.username === username);
    if (!user || !verifyPassword(password, user)) {
      addFail(key);
      return res.status(401).json({ error: "Wrong username or password" });
    }
    attempts.delete(key);
    res.json({ token: createSession(user.id), user: publicUser(user) });
  });

  // POST /api/logout
  router.post("/logout", requireAuth, (req, res) => {
    delete db.sessions[req.token];
    save();
    res.json({ ok: true });
  });

  // PUT /api/profile  -> change display name / about
  router.put("/profile", requireAuth, (req, res) => {
    const name = String((req.body || {}).name ?? req.user.name).trim();
    const about = String((req.body || {}).about ?? req.user.about).trim();
    if (name.length < 2 || name.length > 30) return res.status(400).json({ error: "Name must be 2-30 characters" });
    if (about.length > 80) return res.status(400).json({ error: "About can be at most 80 characters" });
    req.user.name = name;
    req.user.about = about;
    save();
    io.emit("user_updated", publicUser(req.user));
    res.json({ user: publicUser(req.user) });
  });

  return router;
}

module.exports = { createAuthRouter, requireAuth, getUserByToken, publicUser };
