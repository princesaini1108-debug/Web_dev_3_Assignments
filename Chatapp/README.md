# Gupshup - Real-time Chat App (Express + Socket.io)

## Run
```
npm install
npm start          # or: npm run dev  (auto-restart on file change)
```
Open http://localhost:8080 . Register 2 users in 2 different browsers (or normal + incognito window) and chat.

## Folder structure
```
Chatapp/
  server.js        <- YOUR original backend (same code) + NEW parts marked with "NEW" comments
  db.js            <- NEW: tiny JSON database (data/db.json), no installation needed
  auth.js          <- NEW: register / login / logout / profile (password hashing with crypto.scrypt)
  package.json
  public/          <- FRONTEND (served by express.static)
    index.html     <- login/register screen + dashboard + chat screen
    css/style.css  <- design system (light + dark theme, responsive)
    js/common.js   <- helpers (api(), toast, time formatting)
    js/auth.js     <- login/register logic
    js/app.js      <- chat logic (socket events, rendering)
```

## What is unchanged from your original code
`server.js` still has: `count`, the `active`, `chat`, `join`, `msg`, `announce` events,
the `disconnect` handler and port 8080. No new npm package was added.

The frontend uses those original events:
- `active`   -> "Live connections" number on the dashboard
- `join`     -> small toast "New User Joined"
- `announce` -> Announcement card on the dashboard
- `msg`, `chat` -> console log (same as the old client.html)

## Features
- Login / Register (hashed passwords, 30-day session token)
- Dashboard with live stats, online people, quick actions
- Private chat + group chat (default "Everyone" group, create your own)
- Online / last seen, typing indicator
- Message ticks: sent, delivered, read (blue)
- Unread badges, chat search, filters (All / Unread / Groups)
- Reply, emoji reactions, delete for everyone, copy text
- Photo sharing (auto-compressed), emoji picker
- Dark mode, message sound, desktop notifications
- Mobile responsive, messages saved after server restart

## How it works (for viva)
1. **REST (HTTP)**: `/api/register`, `/api/login`, `/api/bootstrap` (initial data). Server returns a random token.
2. **Socket.io**: browser connects with `auth: { token }`. `io.use()` checks the token, otherwise "unauthorized".
3. Every user joins a personal room `user:<id>`, so one message reaches all his open tabs.
4. Chat id: `dm:<idA>:<idB>` (private) or `g:<groupId>` (group).

| Client -> Server | Meaning | Server -> Client |
|---|---|---|
| `send_message` | send text / photo | `message` (to every member) |
| `typing` | user is typing | `typing` |
| `mark_read` | chat opened | `msg_status` (blue ticks) |
| `react` | emoji reaction | `msg_reaction` |
| `delete_message` | delete for everyone | `msg_deleted` |
| `create_group` | new group | `group_created` |
| connect / disconnect | | `presence`, `active` |

Tick logic: **sent** (saved on server) -> **delivered** (receiver online / came online) -> **read** (receiver opened the chat).

## Future improvements
Replace `db.js` with MongoDB / MySQL, voice notes, message pagination, HTTPS.
