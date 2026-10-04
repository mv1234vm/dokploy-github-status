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
<link rel="manifest" href="/manifest.json">
<link id="favicon" rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23ea580c'/%3E%3C/svg%3E">
<meta name="theme-color" content="#ea580c">
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
  #logout,#theme-toggle,#notif-toggle,#export-json,#export-csv,#copy-link,#load-more{background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:.35rem .7rem;font-size:.8rem;cursor:pointer;font-family:inherit}
  #notif-toggle.active{border-color:#ea580c;color:#ea580c}
  .pager{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-top:.75rem}
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
  kbd{font-family:var(--mono);font-size:.75em;background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:0 .3em}
  .timeline-strip{display:flex;gap:3px;flex-wrap:wrap;align-items:center}
  .timeline-strip span{width:10px;height:10px;border-radius:50%;display:inline-block;cursor:default}
  .stats{display:flex;align-items:center;gap:.6rem;margin-left:.5rem}
  .sparkline{display:block}
  .success-rate{font-size:.72rem;font-weight:600;white-space:nowrap}
  .success-rate.good{color:#16a34a}
  .success-rate.bad{color:#dc2626}
  .success-rate.mid{color:#ea580c}
  .avg-duration{font-size:.7rem;color:var(--muted);white-space:nowrap}
  .avg-duration.slow{color:#dc2626;font-weight:600}
  .mute-btn{background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:.2rem .5rem;font-size:.72rem;cursor:pointer;font-family:inherit;white-space:nowrap}
  .mute-btn.active{border-color:#ea580c;color:#ea580c}
  .row.muted{opacity:.55}
  .pw-form{display:flex;flex-wrap:wrap;gap:.5rem;margin:.5rem 0 1rem}
  .pw-form input{flex:1;min-width:12rem;padding:.5rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.85rem}
  .pw-form button{padding:.5rem 1rem;border:none;border-radius:6px;background:#ea580c;color:#fff;font-size:.85rem;cursor:pointer}
  h2{font-size:.85rem;margin:1rem 0 .3rem;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
  .audit-row{display:flex;gap:.6rem;padding:.4rem 0;border-bottom:1px solid var(--border);font-size:.8rem}
  .audit-row:last-child{border-bottom:none}
  .audit-row time{color:var(--muted);white-space:nowrap;min-width:9rem}
  #toggle-security,#toggle-config{background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:.3rem .6rem;font-size:.8rem;cursor:pointer;font-family:inherit}
  .config-row{display:flex;align-items:center;gap:.5rem;margin:.5rem 0}
  .config-row code{flex:1;overflow-x:auto;white-space:nowrap;padding:.4rem .5rem;background:var(--bg);border:1px solid var(--border);border-radius:6px}
  .config-row button,#copy-config-curl{background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:.35rem .7rem;font-size:.8rem;cursor:pointer;font-family:inherit;white-space:nowrap}
  .curl-block{white-space:pre-wrap;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.75rem;font-size:.8rem;margin:.5rem 0;overflow-x:auto}
  details summary{cursor:pointer}
</style>
<div class="wrap">
  <div class="top-nav">
    <a href="/">← Retour</a>
    <div class="right">
      <button id="notif-toggle" title="Notifications navigateur sur nouvel échec">🔔</button>
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
        <h1>Activité récente (tous sites)</h1>
      </div>
      <div id="timeline" class="timeline-strip"></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h1>État de santé (dernier déploiement par site)</h1>
        <span class="refresh-note">Actualisation auto toutes les ${Math.round(REFRESH_MS / 1000)} s (touche <kbd>r</kbd>)</span>
      </div>
      <div id="health"></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h1>Derniers déploiements</h1>
      </div>
      <div class="filters">
        <input id="f-search" type="text" placeholder="Filtrer par repo ou app… (touche /)" />
        <select id="f-status">
          <option value="">Tous les statuts</option>
          <option value="pending">🟠 En cours</option>
          <option value="success">🟢 Réussi</option>
          <option value="failure">🔴 Échoué</option>
          <option value="error">🔴 Erreur</option>
        </select>
        <button id="copy-link" type="button" title="Copier un lien avec ces filtres">🔗 Copier le lien</button>
      </div>
      <div id="list"></div>
      <div class="pager">
        <span id="pager-count" class="note"></span>
        <button id="load-more" type="button" hidden>Charger plus</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h1>Configuration</h1>
        <button id="toggle-config" type="button">Afficher</button>
      </div>
      <div id="config-panel" hidden>
        <p class="note">Webhook à configurer dans Dokploy pour une nouvelle app (Notifications → Add → Webhook) :</p>
        <div class="config-row">
          <code id="config-url">—</code>
          <button id="copy-config-url" type="button">Copier l'URL</button>
        </div>
        <div class="config-row">
          <code id="config-header">—</code>
          <button id="copy-config-header" type="button">Copier le header</button>
        </div>
        <details>
          <summary class="note">Exemple curl complet (test manuel)</summary>
          <pre id="config-curl" class="mono curl-block"></pre>
          <button id="copy-config-curl" type="button">Copier la commande</button>
        </details>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h1>Sécurité</h1>
        <button id="toggle-security" type="button">Afficher</button>
      </div>
      <div id="security-panel" hidden>
        <h2>Changer le mot de passe</h2>
        <div class="pw-form">
          <input id="pw-current" type="password" placeholder="Mot de passe actuel" autocomplete="current-password" />
          <input id="pw-new" type="password" placeholder="Nouveau mot de passe (8+ caractères)" autocomplete="new-password" />
          <button id="pw-change-submit" type="button">Changer</button>
        </div>
        <div id="pw-change-msg" class="note"></div>

        <h2>Journal d'audit</h2>
        <div class="filters">
          <select id="audit-type">
            <option value="">Tous les types</option>
            <option value="login_success">✅ Connexion réussie</option>
            <option value="login_failure">❌ Connexion échouée</option>
            <option value="retry">🔁 Relance</option>
            <option value="password_change">🔑 Mot de passe changé</option>
          </select>
          <input id="audit-ip" type="text" placeholder="Filtrer par IP…" />
          <input id="audit-since" type="date" title="Depuis cette date" />
        </div>
        <div id="audit-log"></div>
      </div>
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
  var PAGE_SIZE = 50;
  var lastData = null;
  var refreshTimer = null;
  var loadedDeployments = [];
  var currentOffset = 0;
  var currentTotal = 0;
  var stats = {};
  var mutedRepos = [];

  function currentFilters() {
    return { status: $("#f-status").value, search: $("#f-search").value.trim() };
  }

  function readFiltersFromUrl() {
    var params = new URLSearchParams(location.search);
    if (params.get("status")) $("#f-status").value = params.get("status");
    if (params.get("search")) $("#f-search").value = params.get("search");
  }

  function syncUrl() {
    var f = currentFilters();
    var params = new URLSearchParams();
    if (f.status) params.set("status", f.status);
    if (f.search) params.set("search", f.search);
    var qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
  }

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

  function fmtDurationMs(ms) {
    if (ms == null) return "—";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "min " + (s % 60) + "s";
  }

  function sparkline(days) {
    if (!days || !days.length) return "";
    var max = Math.max.apply(null, days.concat([1]));
    var w = 4, gap = 2, h = 18;
    var bars = days.map(function (v, i) {
      var barH = Math.max(2, Math.round((v / max) * h));
      var x = i * (w + gap);
      return '<rect x="' + x + '" y="' + (h - barH) + '" width="' + w + '" height="' + barH + '" fill="currentColor" opacity="' + (v ? 1 : 0.25) + '"></rect>';
    }).join("");
    var totalW = days.length * (w + gap) - gap;
    return '<svg class="sparkline" width="' + totalW + '" height="' + h + '" viewBox="0 0 ' + totalW + ' ' + h + '" title="Déploiements / jour, 14 derniers jours">' + bars + '</svg>';
  }

  function rowFor(record, opts) {
    opts = opts || {};
    var meta = STATUS_META[record.status] || { emoji: "⚪", label: record.status };
    var repoKey = record.owner + "/" + record.repo;
    var muted = mutedRepos.indexOf(repoKey) !== -1;
    var row = document.createElement("div");
    row.className = "row" + (muted && opts.withHealth ? " muted" : "");
    row.innerHTML =
      '<span class="emoji">' + (muted && opts.withHealth ? "🔧" : meta.emoji) + "</span>" +
      "<span><span class=\\"name\\">" + repoKey + "</span><br>" +
      "<span class=\\"sub\\">" + (muted && opts.withHealth ? "Maintenance — " : "") + meta.label + (record.description ? " — " + record.description : "") + " · " + fmtDate(record.updatedAt) + "</span></span>";

    if (opts.withHealth) {
      var s = stats[repoKey];
      if (s) {
        var stats_ = document.createElement("span");
        stats_.className = "stats";
        stats_.innerHTML = sparkline(s.days);
        if (s.successRate != null) {
          var rate = document.createElement("span");
          rate.className = "success-rate " + (s.successRate >= 90 ? "good" : s.successRate >= 60 ? "mid" : "bad");
          rate.textContent = s.successRate + "%";
          rate.title = s.sampleSize + " derniers déploiements";
          stats_.appendChild(rate);
        }
        var elapsed = record.status === "pending" ? Date.now() - new Date(record.createdAt).getTime() : null;
        var slow = elapsed != null && s.avgDurationMs && elapsed > s.avgDurationMs * 1.5;
        var dur = document.createElement("span");
        dur.className = "avg-duration" + (slow ? " slow" : "");
        dur.textContent = slow
          ? "⚠ " + fmtDurationMs(elapsed) + " (moy. " + fmtDurationMs(s.avgDurationMs) + ")"
          : "moy. " + fmtDurationMs(s.avgDurationMs);
        stats_.appendChild(dur);
        row.appendChild(stats_);
      }

      var age = fmtAge(record.updatedAt);
      var ageSpan = document.createElement("span");
      ageSpan.className = "age" + (age.stale ? " stale" : "");
      ageSpan.textContent = age.text;
      row.appendChild(ageSpan);

      var muteBtn = document.createElement("button");
      muteBtn.type = "button";
      muteBtn.className = "mute-btn" + (muted ? " active" : "");
      muteBtn.textContent = muted ? "🔧 Maintenance" : "Marquer maintenance";
      muteBtn.addEventListener("click", function () {
        fetch("/api/repos/" + encodeURIComponent(record.owner) + "/" + encodeURIComponent(record.repo) + "/mute", {
          method: "POST",
          headers: authHeader(),
        })
          .then(function (res) { return res.json(); })
          .then(function () { load(true); });
      });
      row.appendChild(muteBtn);
    }

    var a = document.createElement("a");
    a.className = "detail";
    a.href = "/deployments/" + encodeURIComponent(record.id);
    a.textContent = "Détail →";
    row.appendChild(a);
    return row;
  }

  function renderList() {
    var list = $("#list");
    list.innerHTML = "";
    if (!loadedDeployments.length) list.innerHTML = '<p class="note">Aucun déploiement ne correspond.</p>';
    loadedDeployments.forEach(function (r) { list.appendChild(rowFor(r, {})); });

    var shown = loadedDeployments.length;
    $("#pager-count").textContent = currentTotal
      ? shown + " / " + currentTotal + " déploiement(s)"
      : "";
    $("#load-more").hidden = shown >= currentTotal;
  }

  function renderHealth(health) {
    var el = $("#health");
    el.innerHTML = "";
    if (!health.length) el.innerHTML = '<p class="note">Aucun déploiement suivi pour l\\'instant.</p>';
    health.forEach(function (r) { el.appendChild(rowFor(r, { withHealth: true })); });
  }

  function renderTimeline(deployments) {
    var el = $("#timeline");
    el.innerHTML = "";
    if (!deployments.length) { el.innerHTML = '<p class="note">Rien à afficher pour l\\'instant.</p>'; return; }
    deployments.slice(0, 80).forEach(function (r) {
      var meta = STATUS_META[r.status] || { emoji: "⚪", label: r.status, color: "#6b7280" };
      var dot = document.createElement("span");
      dot.style.background = meta.color;
      dot.title = r.owner + "/" + r.repo + " — " + meta.label + " · " + fmtDate(r.createdAt);
      el.appendChild(dot);
    });
  }

  // reset=true : nouveau filtre/premier chargement, on repart de zéro.
  // reset=false : "Charger plus", on ajoute à la suite de ce qui est affiché.
  function load(reset) {
    if (reset) currentOffset = 0;
    var f = currentFilters();
    var params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(currentOffset) });
    if (f.status) params.set("status", f.status);
    if (f.search) params.set("search", f.search);

    fetch("/api/deployments?" + params.toString(), { headers: authHeader() })
      .then(function (res) {
        if (res.status === 401) { showGate(); return null; }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        lastData = data;
        currentTotal = data.total;
        stats = data.stats || {};
        mutedRepos = data.mutedRepos || [];
        loadedDeployments = reset ? data.deployments : loadedDeployments.concat(data.deployments);
        currentOffset = loadedDeployments.length;
        if (reset) checkForNewFailures(data.health);
        renderHealth(data.health);
        renderList();
        if (reset) renderTimeline(data.deployments);
        show($("#app"));
        hide($("#loading"));
        $("#logout").hidden = false;
      })
      .catch(function () {
        hide($("#loading"));
        showGate();
      });

    if (reset) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function () { load(true); }, REFRESH_MS);
    }
  }

  function showGate() {
    hide($("#loading"));
    hide($("#app"));
    show($("#gate"));
  }

  var searchDebounce = null;
  function onFilterChange() {
    syncUrl();
    load(true);
  }
  $("#f-search").addEventListener("input", function () {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(onFilterChange, 300);
  });
  $("#f-status").addEventListener("change", onFilterChange);

  $("#load-more").addEventListener("click", function () { load(false); });

  $("#copy-link").addEventListener("click", function () {
    syncUrl();
    var url = location.href;
    var done = function () {
      var btn = $("#copy-link");
      var original = btn.textContent;
      btn.textContent = "✓ Copié";
      setTimeout(function () { btn.textContent = original; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () { prompt("Lien à copier :", url); });
    } else {
      prompt("Lien à copier :", url);
    }
  });

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
    if (!loadedDeployments.length) return;
    download("deployments.json", JSON.stringify(loadedDeployments, null, 2), "application/json");
  });

  $("#export-csv").addEventListener("click", function () {
    if (!loadedDeployments.length) return;
    var cols = ["id", "owner", "repo", "branch", "appName", "environment", "status", "description", "createdAt", "updatedAt", "finishedAt"];
    var lines = [cols.join(",")];
    loadedDeployments.forEach(function (r) {
      lines.push(cols.map(function (c) {
        var v = r[c] == null ? "" : String(r[c]);
        return '"' + v.replace(/"/g, '""') + '"';
      }).join(","));
    });
    download("deployments.csv", lines.join("\\n"), "text/csv");
  });

  // Alerte "nouvel échec" pendant que l'onglet est ouvert en fond : favicon
  // rouge + notification navigateur si autorisée. Volontairement local au
  // navigateur — pas de notification externe (Slack/Discord/email).
  var FAVICON_NORMAL = $("#favicon").href;
  var FAVICON_ALERT =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23dc2626'/%3E%3C/svg%3E";
  var previousHealthStatus = null; // repoKey -> status, pour détecter les transitions
  var hasFirstLoad = false;

  function setFaviconAlert(on) {
    $("#favicon").href = on ? FAVICON_ALERT : FAVICON_NORMAL;
  }

  function notificationsEnabled() {
    try { return localStorage.getItem("dgs_notifications") === "1"; } catch (e) { return false; }
  }

  function updateNotifButton() {
    $("#notif-toggle").className = notificationsEnabled() ? "active" : "";
  }

  $("#notif-toggle").addEventListener("click", function () {
    if (notificationsEnabled()) {
      try { localStorage.setItem("dgs_notifications", "0"); } catch (e) {}
      updateNotifButton();
      return;
    }
    if (!("Notification" in window)) {
      alert("Ce navigateur ne supporte pas les notifications.");
      return;
    }
    Notification.requestPermission().then(function (perm) {
      if (perm === "granted") {
        try { localStorage.setItem("dgs_notifications", "1"); } catch (e) {}
      }
      updateNotifButton();
    });
  });

  function checkForNewFailures(health) {
    var newFailures = [];
    health.forEach(function (r) {
      var key = r.owner + "/" + r.repo;
      var wasFailing = previousHealthStatus && (previousHealthStatus[key] === "failure" || previousHealthStatus[key] === "error");
      var isFailing = r.status === "failure" || r.status === "error";
      if (isFailing && !wasFailing && hasFirstLoad) newFailures.push(r);
    });
    var nextStatus = {};
    health.forEach(function (r) { nextStatus[r.owner + "/" + r.repo] = r.status; });
    previousHealthStatus = nextStatus;
    hasFirstLoad = true;

    if (newFailures.length) {
      setFaviconAlert(true);
      if (notificationsEnabled() && "Notification" in window && Notification.permission === "granted") {
        newFailures.forEach(function (r) {
          new Notification("Déploiement échoué", {
            body: r.owner + "/" + r.repo + " — " + (r.description || r.status),
            icon: FAVICON_ALERT,
          });
        });
      }
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) setFaviconAlert(false);
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
        load(true);
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

  function renderAuditLog(entries) {
    var el = $("#audit-log");
    el.innerHTML = "";
    if (!entries.length) { el.innerHTML = '<p class="note">Aucune entrée.</p>'; return; }
    var LABELS = {
      login_success: "✅ Connexion réussie",
      login_failure: "❌ Tentative de connexion échouée",
      retry: "🔁 Relance déclenchée",
      password_change: "🔑 Mot de passe changé",
    };
    entries.forEach(function (e) {
      var row = document.createElement("div");
      row.className = "audit-row";
      var extra = e.repo ? " — " + e.owner + "/" + e.repo : "";
      row.innerHTML =
        "<time>" + fmtDate(e.at) + "</time><span>" + (LABELS[e.type] || e.type) + extra + (e.ip ? " (" + e.ip + ")" : "") + "</span>";
      el.appendChild(row);
    });
  }

  function loadAuditLog() {
    var params = new URLSearchParams();
    if ($("#audit-type").value) params.set("type", $("#audit-type").value);
    if ($("#audit-ip").value.trim()) params.set("ip", $("#audit-ip").value.trim());
    if ($("#audit-since").value) params.set("since", $("#audit-since").value);
    fetch("/api/audit-log?" + params.toString(), { headers: authHeader() })
      .then(function (res) { return res.ok ? res.json() : { entries: [] }; })
      .then(function (data) { renderAuditLog(data.entries || []); })
      .catch(function () {});
  }
  $("#audit-type").addEventListener("change", loadAuditLog);
  $("#audit-ip").addEventListener("input", function () {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadAuditLog, 300);
  });
  $("#audit-since").addEventListener("change", loadAuditLog);

  $("#toggle-security").addEventListener("click", function () {
    var panel = $("#security-panel");
    var willShow = panel.hidden;
    panel.hidden = !willShow;
    $("#toggle-security").textContent = willShow ? "Masquer" : "Afficher";
    if (willShow) loadAuditLog();
  });

  function copyText(btn, text) {
    var done = function () {
      var original = btn.textContent;
      btn.textContent = "✓ Copié";
      setTimeout(function () { btn.textContent = original; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { prompt("À copier :", text); });
    } else {
      prompt("À copier :", text);
    }
  }

  var webhookConfig = null;
  $("#toggle-config").addEventListener("click", function () {
    var panel = $("#config-panel");
    var willShow = panel.hidden;
    panel.hidden = !willShow;
    $("#toggle-config").textContent = willShow ? "Masquer" : "Afficher";
    if (willShow && !webhookConfig) {
      fetch("/api/webhook-config", { headers: authHeader() })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          webhookConfig = data;
          $("#config-url").textContent = data.webhookUrl;
          $("#config-header").textContent = data.webhookSecretHeader;
          $("#config-curl").textContent = data.curl;
        })
        .catch(function () {});
    }
  });
  $("#copy-config-url").addEventListener("click", function () { if (webhookConfig) copyText(this, webhookConfig.webhookUrl); });
  $("#copy-config-header").addEventListener("click", function () { if (webhookConfig) copyText(this, webhookConfig.webhookSecretHeader); });
  $("#copy-config-curl").addEventListener("click", function () { if (webhookConfig) copyText(this, webhookConfig.curl); });

  $("#pw-change-submit").addEventListener("click", function () {
    var current = $("#pw-current").value;
    var next = $("#pw-new").value;
    var msg = $("#pw-change-msg");
    msg.textContent = "";
    if (!current || !next) return;
    if (next.length < 8) { msg.textContent = "Le nouveau mot de passe doit faire au moins 8 caractères."; return; }
    $("#pw-change-submit").disabled = true;
    fetch("/api/change-password", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeader()),
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (r) {
        $("#pw-change-submit").disabled = false;
        if (!r.ok) { msg.textContent = r.body.error || "Échec du changement de mot de passe."; return; }
        msg.textContent = r.body.warning ? "✓ Changé — " + r.body.warning : "✓ Mot de passe changé.";
        $("#pw-current").value = "";
        $("#pw-new").value = "";
        loadAuditLog();
      })
      .catch(function () {
        $("#pw-change-submit").disabled = false;
        msg.textContent = "Erreur réseau, réessaie.";
      });
  });

  // Raccourcis clavier : "/" focus la recherche, "r" force une actualisation.
  // Ignorés si on tape déjà dans un champ.
  document.addEventListener("keydown", function (e) {
    var tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (e.key === "/") {
      e.preventDefault();
      $("#f-search").focus();
    } else if (e.key === "r") {
      load(true);
    }
  });

  updateNotifButton();
  readFiltersFromUrl();
  show($("#loading"));
  load(true);
})();
</script>`;
}

module.exports = { renderAdminPage };
