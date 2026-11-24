/* auth.js - login & register screen */
(() => {
  const { $, $$, ic, store, api } = G;

  const COPY = {
    login: ["Welcome back", "Log in to continue your conversations."],
    register: ["Create your account", "It takes less than a minute."],
  };

  function showTab(name) {
    $$(".tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", on);
    });
    $("#login-form").hidden = name !== "login";
    $("#register-form").hidden = name !== "register";
    $("#auth-title").textContent = COPY[name][0];
    $("#auth-sub").textContent = COPY[name][1];
    $$(".form-error").forEach((e) => (e.hidden = true));
    ($(name === "login" ? "#l-username" : "#r-name")).focus();
  }

  function showError(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.hidden = false;
  }

  function setLoading(form, on) {
    const btn = $(".btn.primary", form);
    btn.classList.toggle("loading", on);
    btn.disabled = on;
  }

  // 0-4 score for the password strength meter
  function strength(p) {
    let s = 0;
    if (p.length >= 6) s++;
    if (p.length >= 10) s++;
    if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
    if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
    return p ? Math.max(1, s) : 0;
  }

  G.initAuth = function (onSuccess) {
    $$("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

    // show / hide password
    $$("[data-eye]").forEach((b) =>
      b.addEventListener("click", () => {
        const input = $("#" + b.dataset.eye);
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        b.innerHTML = ic(show ? "eyeoff" : "eye");
        b.setAttribute("aria-label", show ? "Hide password" : "Show password");
      })
    );

    $("#r-password").addEventListener("input", (e) => ($("#strength").dataset.s = strength(e.target.value)));

    async function submit(e, url, body, errId) {
      e.preventDefault();
      const form = e.currentTarget;
      $(errId).hidden = true;
      setLoading(form, true);
      try {
        const data = await api(url, { method: "POST", body });
        G.token = data.token;
        store.set("token", data.token);
        await onSuccess(data.user);
        form.reset();
      } catch (err) {
        showError(errId, err.message);
      } finally {
        setLoading(form, false);
      }
    }

    $("#login-form").addEventListener("submit", (e) => {
      const username = $("#l-username").value.trim();
      const password = $("#l-password").value;
      if (!username || !password) {
        e.preventDefault();
        return showError("#login-error", "Enter your username and password");
      }
      submit(e, "/login", { username, password }, "#login-error");
    });

    $("#register-form").addEventListener("submit", (e) => {
      const name = $("#r-name").value.trim();
      const username = $("#r-username").value.trim().toLowerCase();
      const password = $("#r-password").value;
      const bad = (m) => {
        e.preventDefault();
        showError("#register-error", m);
      };
      if (name.length < 2) return bad("Enter your full name");
      if (!/^[a-z0-9_]{3,20}$/.test(username)) return bad("Username: 3-20 letters, numbers or underscore");
      if (password.length < 6) return bad("Password must be at least 6 characters");
      if (password !== $("#r-confirm").value) return bad("Passwords do not match");
      submit(e, "/register", { name, username, password }, "#register-error");
    });

    showTab("login");
  };
})();
