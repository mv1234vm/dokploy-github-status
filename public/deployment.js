(function () {
  var STATUS_META = window.STATUS_META;
  var id = location.pathname.replace(/^\/deployments\//, "").split(/[/?#]/)[0];
  var params = new URLSearchParams(location.search);
  var linkToken = params.get("t");

  var $ = function (sel) { return document.querySelector(sel); };
  var show = function (el) { el.hidden = false; };
  var hide = function (el) { el.hidden = true; };

  function authHeader() {
    var session = localStorage.getItem("dgs_session_token");
    if (session) return { Authorization: "Bearer " + session };
    var linkKey = "dgs_link_" + id;
    var storedLink = linkToken || localStorage.getItem(linkKey);
    if (storedLink) return { "x-link-token": storedLink };
    return {};
  }

  function rememberLinkTokenIfAny() {
    if (linkToken) localStorage.setItem("dgs_link_" + id, linkToken);
  }

  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }
  (function initTheme() {
    try {
      var saved = localStorage.getItem("dgs_theme");
      if (saved) applyTheme(saved);
    } catch (e) {}
  })();
  $("#theme-toggle").addEventListener("click", function () {
    var current = document.documentElement.getAttribute("data-theme");
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var effectiveDark = current ? current === "dark" : prefersDark;
    var next = effectiveDark ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("dgs_theme", next); } catch (e) {}
  });

  var pollTimer = null;

  function fmtDate(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  function fmtDuration(start, end) {
    if (!start) return "—";
    var ms = new Date(end || Date.now()) - new Date(start);
    if (!(ms >= 0)) return "—";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + " s";
    var m = Math.floor(s / 60);
    return m + " min " + (s % 60) + " s";
  }

  function render(record) {
    var meta = STATUS_META[record.status] || { emoji: "⚪", label: record.status, color: "#6b7280", poll: false };
    var banner = $("#status-banner");
    banner.style.background = meta.color + "1a";
    banner.style.color = meta.color;
    $("#status-emoji").textContent = meta.emoji;
    $("#status-label").textContent = meta.label;
    $("#status-sub").textContent = record.description || "";

    var bar = $("#bar-wrap");
    if (meta.poll) {
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "bar-wrap";
        bar.className = "bar";
        bar.innerHTML = "<div></div>";
        banner.appendChild(bar);
      }
    } else if (bar) {
      bar.remove();
    }

    $("#f-repo").textContent = record.owner + "/" + record.repo;
    $("#f-id").textContent = record.id;
    $("#f-appname").textContent = record.appName || "—";
    $("#f-env").textContent = record.environment || "—";
    $("#f-branch").textContent = record.branch || "—";
    $("#f-sha").textContent = record.sha ? record.sha.slice(0, 12) : "—";
    $("#f-created").textContent = fmtDate(record.createdAt);
    $("#f-finished").textContent = record.finishedAt ? fmtDate(record.finishedAt) : "—";
    $("#f-duration").textContent = fmtDuration(record.createdAt, record.finishedAt);

    var actions = $("#actions");
    actions.innerHTML = "";
    var repoUrl = "https://github.com/" + record.owner + "/" + record.repo;
    addAction(actions, "GitHub", repoUrl);
    if (record.sha) addAction(actions, "Voir le commit", repoUrl + "/commit/" + record.sha);
    if (record.previousSha && record.sha) {
      addAction(actions, "Comparer avec le précédent", repoUrl + "/compare/" + record.previousSha + "..." + record.sha);
    }
    if (record.appUrl) addAction(actions, "Voir le site", record.appUrl);
    if (record.dokployLogUrl) addAction(actions, "Logs Dokploy", record.dokployLogUrl);

    var canRetry = (record.status === "failure" || record.status === "error") &&
      !!localStorage.getItem("dgs_session_token");
    if (canRetry) {
      var retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.textContent = "Relancer";
      retryBtn.className = "retry-btn";
      retryBtn.addEventListener("click", function () {
        retryBtn.disabled = true;
        retryBtn.textContent = "Relance en cours…";
        fetch("/api/deployments/" + encodeURIComponent(id) + "/retry", {
          method: "POST",
          headers: authHeader(),
        })
          .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
          .then(function (r) {
            retryBtn.disabled = false;
            retryBtn.textContent = r.ok ? "Relance déclenchée ✓" : (r.body.error || "Échec de la relance");
            if (r.ok) setTimeout(load, 5000);
          })
          .catch(function () {
            retryBtn.disabled = false;
            retryBtn.textContent = "Erreur réseau, réessaie";
          });
      });
      actions.appendChild(retryBtn);
    }

    var tl = $("#timeline");
    tl.innerHTML = "";
    (record.history || []).forEach(function (h) {
      var hm = STATUS_META[h.status] || { emoji: "⚪", label: h.status };
      var li = document.createElement("li");
      var time = document.createElement("time");
      time.textContent = fmtDate(h.at).split(", ")[1] || fmtDate(h.at);
      var span = document.createElement("span");
      span.textContent = hm.emoji + " " + hm.label + (h.description ? " — " + h.description : "");
      li.appendChild(time);
      li.appendChild(span);
      tl.appendChild(li);
    });

    show($("#app"));
    hide($("#loading"));
    $("#logout").hidden = false;
    if (localStorage.getItem("dgs_session_token")) $("#admin-link").hidden = false;

    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (meta.poll) pollTimer = setTimeout(load, 5000);
  }

  function addAction(container, label, href) {
    var a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    container.appendChild(a);
  }

  function load() {
    fetch("/api/deployments/" + encodeURIComponent(id), { headers: authHeader() })
      .then(function (res) {
        if (res.status === 401) { showGate(); return null; }
        if (res.status === 404 || res.status === 400) { showNotFound(); return null; }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (record) {
        if (record) { rememberLinkTokenIfAny(); render(record); }
      })
      .catch(function () {
        hide($("#loading"));
        showNotFound();
      });
  }

  function showGate() {
    hide($("#loading"));
    hide($("#app"));
    hide($("#notfound"));
    show($("#gate"));
  }

  function showNotFound() {
    hide($("#loading"));
    hide($("#app"));
    hide($("#gate"));
    show($("#notfound"));
  }

  $("#pw-submit").addEventListener("click", function () {
    var pw = $("#pw").value;
    if (!pw) return;
    $("#pw-submit").disabled = true;
    $("#pw-error").textContent = "";
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (r) {
        $("#pw-submit").disabled = false;
        if (!r.ok) {
          $("#pw-error").textContent = r.body.error || "Mot de passe incorrect.";
          return;
        }
        localStorage.setItem("dgs_session_token", r.body.token);
        hide($("#gate"));
        show($("#loading"));
        load();
      })
      .catch(function () {
        $("#pw-submit").disabled = false;
        $("#pw-error").textContent = "Erreur réseau, réessaie.";
      });
  });
  $("#pw").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("#pw-submit").click();
  });

  $("#logout").addEventListener("click", function () {
    Object.keys(localStorage)
      .filter(function (k) { return k.indexOf("dgs_") === 0; })
      .forEach(function (k) { localStorage.removeItem(k); });
    location.href = location.pathname;
  });

  if (!/^[0-9]+$/.test(id)) {
    showNotFound();
  } else {
    show($("#loading"));
    load();
  }
})();
