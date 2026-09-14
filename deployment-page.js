// Page unique servie pour toute URL /deployments/:id. Le rendu réel est fait
// côté client : ce fichier ne contient aucune donnée de déploiement, juste le
// gabarit + la logique d'authentification/affichage. L'id vient de
// location.pathname, jamais codé en dur ici — impossible de mélanger deux
// déploiements puisque chaque page ne charge que /api/deployments/<son-id>.

const STATUS_META = {
  pending: { emoji: "🔵", label: "En cours", color: "#2563eb", poll: true },
  success: { emoji: "🟢", label: "Réussi", color: "#16a34a", poll: false },
  failure: { emoji: "🔴", label: "Échoué", color: "#dc2626", poll: false },
  error: { emoji: "🔴", label: "Erreur", color: "#dc2626", poll: false },
};

function renderDeploymentPage() {
  return `<title>Détail du déploiement</title>
<style>
  :root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--text:#1a1a1a;--muted:#6b7280;--border:#e5e7eb;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  @media (prefers-color-scheme:dark){:root{--bg:#111214;--card:#1b1c1f;--text:#f0f0f0;--muted:#9aa0a6;--border:#2c2d31}}
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:0 0 4rem}
  a{color:inherit}
  .wrap{max-width:760px;margin:0 auto;padding:1.5rem 1rem}
  .top-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;font-size:.9rem}
  .top-nav a{color:var(--muted);text-decoration:none}
  .top-nav a:hover{text-decoration:underline}
  #logout{background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:.35rem .7rem;font-size:.8rem;cursor:pointer}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;margin-bottom:1rem}
  .status-banner{display:flex;align-items:center;gap:.75rem;padding:1.1rem 1.25rem;border-radius:12px;margin-bottom:1rem;font-size:1.15rem;font-weight:600}
  .status-emoji{font-size:1.6rem;line-height:1}
  .status-sub{font-weight:400;font-size:.85rem;color:var(--muted);margin-top:.15rem}
  .bar{height:6px;border-radius:3px;background:var(--border);overflow:hidden;margin-top:.75rem}
  .bar > div{height:100%;width:35%;background:currentColor;animation:slide 1.4s ease-in-out infinite}
  @keyframes slide{0%{margin-left:-35%}100%{margin-left:100%}}
  h1{font-size:1.1rem;margin:0 0 .9rem}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:.9rem 1.5rem}
  @media (max-width:520px){.grid{grid-template-columns:1fr}}
  .field dt{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:.15rem}
  .field dd{margin:0;word-break:break-word}
  code,.mono{font-family:var(--mono);font-size:.85em}
  .timeline{list-style:none;margin:0;padding:0}
  .timeline li{display:flex;gap:.75rem;padding:.5rem 0;border-bottom:1px solid var(--border)}
  .timeline li:last-child{border-bottom:none}
  .timeline time{color:var(--muted);font-size:.8rem;white-space:nowrap;min-width:5.5rem}
  .actions{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:.25rem}
  .actions a{display:inline-block;padding:.5rem .9rem;border:1px solid var(--border);border-radius:8px;text-decoration:none;font-size:.85rem}
  .actions a:hover{background:var(--border)}
  .retry-btn{padding:.5rem .9rem;border:1px solid #dc2626;border-radius:8px;font-size:.85rem;background:none;color:#dc2626;cursor:pointer;font-family:inherit}
  .retry-btn:disabled{opacity:.6;cursor:default}
  .note{color:var(--muted);font-size:.85rem}
  .center{max-width:380px;margin:4rem auto;text-align:center}
  input[type=password]{width:100%;padding:.65rem .8rem;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:1rem;margin:.75rem 0}
  button.primary{width:100%;padding:.7rem;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:1rem;cursor:pointer}
  button.primary:disabled{opacity:.6;cursor:default}
  .error-msg{color:#dc2626;font-size:.85rem;min-height:1.2em;margin-top:.4rem}
</style>
<div class="wrap">
  <div class="top-nav">
    <a href="/">← Retour</a>
    <span style="display:flex;gap:.75rem;align-items:center">
      <a id="admin-link" href="/deployments" hidden>Tous les sites</a>
      <button id="logout" hidden>Se déconnecter</button>
    </span>
  </div>

  <div id="gate" class="center" hidden>
    <h1>🔒 Accès protégé</h1>
    <p class="note">Cette page de déploiement est protégée. Entrez le mot de passe pour continuer.</p>
    <input id="pw" type="password" placeholder="Mot de passe" autocomplete="current-password" />
    <button id="pw-submit" class="primary">Accéder au déploiement</button>
    <div id="pw-error" class="error-msg"></div>
  </div>

  <div id="notfound" class="center" hidden>
    <h1>404 — Déploiement introuvable</h1>
    <p class="note">Aucun déploiement ne correspond à cet identifiant (il n'existe pas, ou le service a redémarré depuis qu'il a été créé).</p>
  </div>

  <div id="loading" class="center" hidden><p class="note">Chargement…</p></div>

  <div id="app" hidden>
    <div id="status-banner" class="status-banner">
      <span id="status-emoji" class="status-emoji"></span>
      <div>
        <div id="status-label"></div>
        <div id="status-sub" class="status-sub"></div>
      </div>
    </div>

    <div class="card">
      <h1>Informations</h1>
      <dl class="grid">
        <div class="field"><dt>Projet</dt><dd id="f-repo">—</dd></div>
        <div class="field"><dt>ID déploiement</dt><dd id="f-id" class="mono">—</dd></div>
        <div class="field"><dt>Application</dt><dd id="f-appname">—</dd></div>
        <div class="field"><dt>Environnement</dt><dd id="f-env">—</dd></div>
        <div class="field"><dt>Branche</dt><dd id="f-branch" class="mono">—</dd></div>
        <div class="field"><dt>Commit</dt><dd id="f-sha" class="mono">—</dd></div>
        <div class="field"><dt>Lancé le</dt><dd id="f-created">—</dd></div>
        <div class="field"><dt>Terminé le</dt><dd id="f-finished">—</dd></div>
        <div class="field"><dt>Durée</dt><dd id="f-duration">—</dd></div>
      </dl>
      <div class="actions" id="actions"></div>
    </div>

    <div class="card">
      <h1>Timeline</h1>
      <ul class="timeline" id="timeline"></ul>
    </div>

    <p class="note" id="logs-note">Les logs détaillés ne sont pas rapatriés par ce service ; utilise le lien « Logs Dokploy » ci-dessus pour les consulter.</p>
  </div>
</div>

<script>
(function () {
  var STATUS_META = ${JSON.stringify(STATUS_META)};
  var id = location.pathname.replace(/^\\/deployments\\//, "").split(/[/?#]/)[0];
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
</script>`;
}

module.exports = { renderDeploymentPage, STATUS_META };
