// Page d'accueil publique ("/") : aucune donnée sensible, juste une vitrine
// du service et un point d'entrée vers le tableau de bord. Même charte
// graphique que deployment-page.js/admin-page.js (variables CSS partagées).

function renderLandingPage() {
  return `<title>dokploy-github-status</title>
<meta name="theme-color" content="#ea580c">
<style>
  :root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--text:#1a1a1a;--muted:#6b7280;--border:#e5e7eb;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  @media (prefers-color-scheme:dark){:root{--bg:#111214;--card:#1b1c1f;--text:#f0f0f0;--muted:#9aa0a6;--border:#2c2d31}}
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:0 0 4rem}
  a{color:inherit}
  .wrap{max-width:640px;margin:0 auto;padding:3rem 1.25rem 1rem}
  .badge{display:inline-flex;align-items:center;gap:.4rem;background:#16a34a1a;color:#16a34a;border-radius:999px;padding:.3rem .8rem;font-size:.8rem;font-weight:600;margin-bottom:1.25rem}
  .badge .dot{width:.5rem;height:.5rem;border-radius:50%;background:currentColor}
  h1{font-size:1.5rem;margin:0 0 .5rem}
  .lead{color:var(--muted);font-size:.95rem;margin:0 0 2rem;max-width:34rem}
  .cta{display:inline-block;background:#ea580c;color:#fff;text-decoration:none;font-weight:600;font-size:.9rem;padding:.7rem 1.3rem;border-radius:8px;margin-bottom:2.5rem}
  .cta:hover{opacity:.92}
  h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 .75rem}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:0;margin-bottom:1rem;overflow:hidden}
  .route{display:flex;align-items:baseline;gap:.75rem;padding:.75rem 1rem;border-bottom:1px solid var(--border);font-size:.85rem}
  .route:last-child{border-bottom:none}
  .route .method{font-family:var(--mono);font-weight:700;font-size:.72rem;color:#ea580c;min-width:3.2rem}
  .route .path{font-family:var(--mono);white-space:nowrap}
  .route .desc{color:var(--muted);flex:1}
  .footer{color:var(--muted);font-size:.8rem;margin-top:2rem}
  .footer a{text-decoration:underline}
  @media (max-width:480px){.route{flex-wrap:wrap}.route .desc{flex-basis:100%}}
</style>
<div class="wrap">
  <span class="badge"><span class="dot"></span>Service actif</span>
  <h1>dokploy-github-status</h1>
  <p class="lead">Relie Dokploy et GitHub : chaque déploiement pose sur le commit la pastille ✅ 🟠 ❌ native de GitHub, avec une page de détail dédiée et un tableau de bord santé pour tous les sites.</p>
  <a class="cta" href="/deployments">Ouvrir le tableau de bord →</a>

  <h2>Routes</h2>
  <div class="card">
    <div class="route"><span class="method">POST</span><span class="path">/webhook</span><span class="desc">Notification Dokploy (fin de déploiement)</span></div>
    <div class="route"><span class="method">POST</span><span class="path">/github</span><span class="desc">Webhook GitHub push, statut « en cours » instantané</span></div>
    <div class="route"><span class="method">GET</span><span class="path">/deployments/:id</span><span class="desc">Page de détail d'un déploiement</span></div>
    <div class="route"><span class="method">GET</span><span class="path">/deployments</span><span class="desc">Tableau de bord — mot de passe requis</span></div>
    <div class="route"><span class="method">GET</span><span class="path">/health</span><span class="desc">Disponibilité + état du sondage Dokploy</span></div>
  </div>

  <p class="footer"><a href="https://github.com/mv1234vm/dokploy-github-status" target="_blank" rel="noopener noreferrer">Code source sur GitHub</a></p>
</div>`;
}

module.exports = { renderLandingPage };
