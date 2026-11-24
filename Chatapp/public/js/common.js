/* common.js - small helpers shared by auth.js and app.js */
window.G = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // escape user text before putting it into HTML (prevents XSS)
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // <svg> icon from the sprite in index.html
  const ic = (name, cls = "") => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;

  // localStorage wrapper (never crashes if storage is blocked)
  const store = {
    get(k, d = null) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };

  const G = { $, $$, esc, ic, store, token: store.get("token") };

  // fetch() wrapper for our REST API
  G.api = async (path, { method = "GET", body } = {}) => {
    const res = await fetch("/api" + path, {
      method,
      headers: { "Content-Type": "application/json", ...(G.token ? { Authorization: "Bearer " + G.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "Something went wrong. Please try again.");
      err.status = res.status;
      throw err;
    }
    return data;
  };

  G.toast = (msg, type = "info") => {
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    $("#toasts").append(el);
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 300);
    }, 3200);
  };

  /* ---------- time helpers ---------- */
  const startOfDay = (t) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();
  G.time = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  G.dayDiff = (t) => Math.round((startOfDay(Date.now()) - startOfDay(t)) / 86400000);
  G.dayKey = (t) => new Date(t).toDateString();
  G.dayLabel = (t) => {
    const d = G.dayDiff(t);
    if (d === 0) return "Today";
    if (d === 1) return "Yesterday";
    return new Date(t).toLocaleDateString([], { day: "numeric", month: "long", year: d > 300 ? "numeric" : undefined });
  };
  G.listTime = (t) => {
    const d = G.dayDiff(t);
    if (d === 0) return G.time(t);
    if (d === 1) return "Yesterday";
    return new Date(t).toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
  };

  G.initials = (name) =>
    String(name || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();

  return G;
})();
