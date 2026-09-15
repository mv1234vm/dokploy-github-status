// Page /deployments : liste des derniers déploiements + état de santé de
// tous les sites. Contrairement à /deployments/:id, un jeton de lien GitHub
// ne donne JAMAIS accès ici — seul le mot de passe (jeton de session) le
// permet, voir isSessionAuthorized() côté serveur.

const { STATUS_META } = require("./deployment-page");

const REFRESH_MS = 8000;
// Au-delà de ce délai sans nouveau déploiement pour un repo, le badge passe
// en orange (site probablement oublié) — purement indicatif, pas une alerte.
const STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function renderAdminPage() {
  return `<title>Tous les sites</title>
<style>
  :root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--text:#1a1a1a;--muted:#6b7280;--border:#e5e7eb;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111214;--card:#1b1c1f;--text:#f0f0f0;--muted:#9aa0a6;--border:#2c2d31}}
  :root[data-theme="dark"]{--bg:#111214;--card:#1b1c1f;--text:#f0f0f0;--muted:#9aa0a6;--border:#2c2d31}
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:0 0 4rem}
  a{color:inherit}
  .wrap{max-width:900px;margin:0 auto;padding:1.5rem 1rem}
  .top-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;font-size:.9rem;gap:.75rem}
  .top-nav a{color:var(--muted);text-decoration:none}
  .top-nav a:hover{text-decoration:underline}
  .top-nav .right{display:flex;align-items:center;gap:.5rem}
  #logout,#theme-toggle,#export-json,#export-csv{background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:.35rem .7rem;font-size:.8rem;cursor:pointer;font-family:inherit}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;margin-bottom:1rem}
  .card-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:.9rem}
  h1{font-size:1.1rem;margin:0}
  .filters{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem}
  .filters input,.filters select{padding:.45rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.85rem;font-family:inherit}
  .filters input{flex:1;min-width:10rem}
  .row{display:flex;align-items:center;gap:.75rem;padding:.6rem 0;border-bottom:1px solid var(--border);font-size:.9rem}
  .row:last-child{border-bottom:none}
  .emoji{font-size:1.2rem;line-height:1}
  .row .name{font-weight:600}
  .row .sub{color:var(--muted);font-size:.8rem}
  .row .age{margin-left:auto;font-size:.75rem;color:var(--muted);white-space:nowrap}
  .row .age.stale{color:#ea580c}
  .row a.detail{font-size:.8rem;color:var(--muted);text-decoration:underline;white-space:nowrap}
  code,.mono{font-family:var(--mono);font-size:.85em}
  .note{color:var(--muted);font-size:.85rem}
  .center{max-width:380px;margin:4rem auto;text-align:center}
  input[type=password]{width:100%;padding:.65rem .8rem;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:1rem;margin:.75rem 0}
  button.primary{width:100%;padding:.7rem;border:none;border-radius:8px;background:#ea580c;color:#fff;font-size:1rem;cursor:pointer}
  button.primary:disabled{opacity:.6;cursor:default}
  .error-msg{color:#dc2626;font-size:.85rem;min-height:1.2em;margin-top:.4rem}
  .refresh-note{color:var(--muted);font-size:.75rem}
</style>
<div class="wrap">
  <div class="top-nav">
    <a href="/">← Retour</a>
    <div class="right">
      <button id="theme-toggle" title="Changer de thème">🌓</button>
      <button id="export-json">Export JSON</button>
      <button id="export-csv">Export CSV</button>
      <button id="logout" hidden>Se déconnecter</button>
    </div>
  </div>

  <div id="gate" class="center" hidden>
    <h1>🔒 Accès protégé</h1>
    <p class="note">Cette page est protégée par mot de passe.</p>
    <input id="pw" type="password" placeholder="Mot de passe" autocomplete="current-password" />
    <button id="pw-submit" class="primary">Accéder</button>
    <div id="pw-error" class="error-msg"></div>
  </div>

  <div id="loading" class="center" hidden><p class="note">Chargement…</p></div>

  <div id="app" hidden>
    <div class="card">
      <div class="card-head">
        <h1>État de santé (dernier déploiement par site)</h1>
        <span class="refresh-note">Actualisation auto toutes les ${Math.round(REFRESH_MS / 1000)} s</span>
      </div>
      <div id="health"></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h1>Derniers déploiements</h1>
      </div>
      <div class="filters">
        <input id="f-search" type="text" placeholder="Filtrer par repo ou app…" />
        <select id="f-status">
          <option value="">Tous les statuts</option>
          <option value="pending">🟠 En cours</option>
          <option value="success">🟢 Réussi</option>
          <option value="failure">🔴 Échoué</option>
          <option value="error">🔴 Erreur</option>
        </select>
      </div>
      <div id="list"></div>
    </div>
  </div>
</div>

<script>
(function () {
  var STATUS_META = ${JSON.stringify(STATUS_META)};
  var STALE_MS = ${STALE_MS};
  var REFRESH_MS = ${REFRESH_MS};
  var $ = function (sel) { return document.querySelector(sel); };
  var show = function (el) { el.hidden = false; };
  var hide = function (el) { el.hidden = true; };
  var lastData = null;
  var refreshTimer = null;

  function authHeader() {
    var session = localStorage.getItem("dgs_session_token");
    return session ? { Authorization: "Bearer " + session } : {};
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  function fmtAge(iso) {
    if (!iso) return { text: "—", stale: false };
    var ms = Date.now() - new Date(iso).getTime();
    if (!(ms >= 0)) return { text: "—", stale: false };
    var stale = ms > STALE_MS;
    var mins = Math.floor(ms / 60000);
    var text;
    if (mins < 1) text = "à l'instant";
    else if (mins < 60) text = "il y a " + mins + " min";
    else if (mins < 1440) text = "il y a " + Math.floor(mins / 60) + " h";
    else text = "il y a " + Math.floor(mins / 1440) + " j";
    return { text: text, stale: stale };
  }

  function rowFor(record, withAge) {
    var meta = STATUS_META[record.status] || { emoji: "⚪", label: record.status };
    var row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      '<span class="emoji">' + meta.emoji + "</span>" +
      "<span><span class=\\"name\\">" + record.owner + "/" + record.repo + "</span><br>" +
      "<span class=\\"sub\\">" + meta.label + (record.description ? " — " + record.description : "") + " · " + fmtDate(record.updatedAt) + "</span></span>";
    if (withAge) {
      var age = fmtAge(record.updatedAt);
      var ageSpan = document.createElement("span");
      ageSpan.className = "age" + (age.stale ? " stale" : "");
      ageSpan.textContent = age.text;
      row.appendChild(ageSpan);
    }
    var a = document.createElement("a");
    a.className = "detail";
    a.href = "/deployments/" + encodeURIComponent(record.id);
    a.textContent = "Détail →";
    row.appendChild(a);
    return row;
  }

  function applyFilters(deployments) {
    var search = $("#f-search").value.trim().toLowerCase();
    var status = $("#f-status").value;
    return deployments.filter(function (r) {
      if (status && r.status !== status) return false;
      if (search) {
        var hay = (r.owner + "/" + r.repo + " " + (r.appName || "")).toLowerCase();
        if (hay.indexOf(search) === -1) return false;
      }
      return true;
    });
  }

  function renderList() {
    if (!lastData) return;
    var list = $("#list");
    list.innerHTML = "";
    var filtered = applyFilters(lastData.deployments);
    if (!filtered.length) list.innerHTML = '<p class="note">Aucun déploiement ne correspond.</p>';
    filtered.forEach(function (r) { list.appendChild(rowFor(r, false)); });
  }

  function render(data) {
    lastData = data;
    var health = $("#health");
    health.innerHTML = "";
    if (!data.health.length) health.innerHTML = '<p class="note">Aucun déploiement suivi pour l\\'instant.</p>';
    data.health.forEach(function (r) { health.appendChild(rowFor(r, true)); });

    renderList();

    show($("#app"));
    hide($("#loading"));
    $("#logout").hidden = false;
  }

  function load() {
    fetch("/api/deployments", { headers: authHeader() })
      .then(function (res) {
        if (res.status === 401) { showGate(); return null; }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () {
        hide($("#loading"));
        showGate();
      })
      .then(function () {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(load, REFRESH_MS);
      });
  }

  function showGate() {
    hide($("#loading"));
    hide($("#app"));
    show($("#gate"));
  }

  $("#f-search").addEventListener("input", renderList);
  $("#f-status").addEventListener("change", renderList);

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  $("#export-json").addEventListener("click", function () {
    if (!lastData) return;
    download("deployments.json", JSON.stringify(lastData.deployments, null, 2), "application/json");
  });

  $("#export-csv").addEventListener("click", function () {
    if (!lastData) return;
    var cols = ["id", "owner", "repo", "branch", "appName", "environment", "status", "description", "createdAt", "updatedAt", "finishedAt"];
    var lines = [cols.join(",")];
    lastData.deployments.forEach(function (r) {
      lines.push(cols.map(function (c) {
        var v = r[c] == null ? "" : String(r[c]);
        return '"' + v.replace(/"/g, '""') + '"';
      }).join(","));
    });
    download("deployments.csv", lines.join("\\n"), "text/csv");
  });

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
    if (refreshTimer) clearTimeout(refreshTimer);
    Object.keys(localStorage)
      .filter(function (k) { return k.indexOf("dgs_") === 0; })
      .forEach(function (k) { localStorage.removeItem(k); });
    location.href = location.pathname;
  });

  show($("#loading"));
  load();
})();
</script>`;
}

module.exports = { renderAdminPage };
