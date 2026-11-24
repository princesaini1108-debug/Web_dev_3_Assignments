// db.js  (NEW)
// Very small "database" -> everything is stored in data/db.json
// Why? So the project runs with ZERO extra setup (no MongoDB / MySQL install).
// Later you can replace this file with MongoDB/MySQL and nothing else changes.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "db.json");
fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });

// users    -> registered people
// groups   -> group chats (one default group "Everyone")
// messages -> every chat message (private + group)
// sessions -> login tokens
let db = { users: [], groups: [], messages: [], sessions: {} };

if (fs.existsSync(FILE)) {
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch (e) {
    console.error("data/db.json is corrupted, starting with an empty database");
  }
}

// Default group that every new user joins automatically
if (!db.groups.find((g) => g.id === "everyone")) {
  db.groups.push({
    id: "everyone",
    name: "Everyone",
    about: "Common group for all users",
    members: [],
    admin: null,
    color: "#0B7A75",
    createdAt: Date.now(),
  });
}

// Debounced save: many changes in a short time -> only one disk write
let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(saveNow, 300);
}
function saveNow() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
// Make sure nothing is lost when the server is stopped with Ctrl+C
["SIGINT", "SIGTERM"].forEach((sig) =>
  process.on(sig, () => {
    saveNow();
    process.exit(0);
  })
);

const uid = () => crypto.randomBytes(8).toString("hex");

module.exports = { db, save, uid };
