// Page /deployments : liste des derniers déploiements + état de santé de
// tous les sites. Contrairement à /deployments/:id, un jeton de lien GitHub
// ne donne JAMAIS accès ici — seul le mot de passe (jeton de session) le
// permet, voir isSessionAuthorized() côté serveur.

const { STATUS_META } = require("./deployment-page");

function renderAdminPage() {
  return `<title>Tous les sites</title>
<style>
  :root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--text:#1a1a1a;--muted:#6b7280;--border:#e5e7eb;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  @media (prefers-color-scheme:dark){:root{--bg:#111214;--card:#1b1c1f;--text:#f0f0f0;--muted:#9aa0a6;--border:#2c2d31}}
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:0 0 4rem}
  a{color:inherit}
  .wrap{max-width:900px;margin:0 auto;padding:1.5rem 1rem}
  .top-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;font-size:.9rem}
  .top-nav a{color:var(--muted);text-decoration:none}
  .top-nav a:hover{text-decoration:underline}
  #logout{background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:.35rem .7rem;font-size:.8rem;cursor:pointer}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;margin-bottom:1rem}
  h1{font-size:1.1rem;margin:0 0 .9rem}
  .row{display:flex;align-items:center;gap:.75rem;padding:.6rem 0;border-bottom:1px solid var(--border);font-size:.9rem}
  .row:last-child{border-bottom:none}
  .emoji{font-size:1.2rem;line-height:1}
  .row .name{font-weight:600}
  .row .sub{color:var(--muted);font-size:.8rem}
  .row a{margin-left:auto;font-size:.8rem;color:var(--muted);text-decoration:underline;white-space:nowrap}
  code,.mono{font-family:var(--mono);font-size:.85em}
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
    <button id="logout" hidden>Se déconnecter</button>
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
      <h1>État de santé (dernier déploiement par site)</h1>
      <div id="health"></div>
    </div>
    <div class="card">
      <h1>Derniers déploiements</h1>
      <div id="list"></div>
    </div>
  </div>
</div>

<script>
(function () {
  var STATUS_META = ${JSON.stringify(STATUS_META)};
  var $ = function (sel) { return document.querySelector(sel); };
  var show = function (el) { el.hidden = false; };
  var hide = function (el) { el.hidden = true; };

  function authHeader() {
    var session = localStorage.getItem("dgs_session_token");
    return session ? { Authorization: "Bearer " + session } : {};
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  function rowFor(record) {
    var meta = STATUS_META[record.status] || { emoji: "⚪", label: record.status };
    var row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      '<span class="emoji">' + meta.emoji + "</span>" +
      "<span><span class=\\"name\\">" + record.owner + "/" + record.repo + "</span><br>" +
      "<span class=\\"sub\\">" + meta.label + (record.description ? " — " + record.description : "") + " · " + fmtDate(record.updatedAt) + "</span></span>";
    var a = document.createElement("a");
    a.href = "/deployments/" + encodeURIComponent(record.id);
    a.textContent = "Détail →";
    row.appendChild(a);
    return row;
  }

  function render(data) {
    var health = $("#health");
    health.innerHTML = "";
    if (!data.health.length) health.innerHTML = '<p class="note">Aucun déploiement suivi pour l\\'instant.</p>';
    data.health.forEach(function (r) { health.appendChild(rowFor(r)); });

    var list = $("#list");
    list.innerHTML = "";
    if (!data.deployments.length) list.innerHTML = '<p class="note">Aucun déploiement suivi pour l\\'instant.</p>';
    data.deployments.forEach(function (r) { list.appendChild(rowFor(r)); });

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
      });
  }

  function showGate() {
    hide($("#loading"));
    hide($("#app"));
    show($("#gate"));
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

  show($("#loading"));
  load();
})();
</script>`;
}

module.exports = { renderAdminPage };
