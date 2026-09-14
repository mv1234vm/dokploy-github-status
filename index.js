const crypto = require("crypto");
const express = require("express");
const store = require("./store");
const { makeSigner } = require("./auth");
const { renderDeploymentPage } = require("./deployment-page");

const app = express();
// On garde le corps brut pour vérifier la signature des webhooks GitHub
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.disable("x-powered-by");
// Derrière le reverse-proxy Dokploy (Traefik) : sans ça, req.ip vaut toujours
// l'IP interne du proxy et le throttle anti brute-force partagerait le même
// compteur pour tout le monde.
app.set("trust proxy", true);

const PORT = 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
// Clé API Dokploy : permet de retrouver automatiquement le repo GitHub de chaque app
const DOKPLOY_API_KEY = process.env.DOKPLOY_API_KEY || "";
// URL Dokploy (optionnel : sinon déduite du lien contenu dans la notification)
const DOKPLOY_URL = (process.env.DOKPLOY_URL || "").replace(/\/+$/, "");
// Fallbacks facultatifs si on n'utilise pas l'API Dokploy
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
// Optionnel : secret d'un webhook GitHub "push" pour poser le statut "en cours"
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
// Pages /deployments/:id : URL publique de CE service (pour construire les
// liens qu'on pose sur GitHub) + mot de passe d'accès direct.
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
let APP_MAP = {};
try {
  APP_MAP = process.env.APP_MAP ? JSON.parse(process.env.APP_MAP) : {};
} catch {
  console.error("[config] APP_MAP n'est pas un JSON valide. Ignoré.");
}

if (!GITHUB_TOKEN || !WEBHOOK_SECRET) {
  console.error("[config] GITHUB_TOKEN et WEBHOOK_SECRET sont obligatoires. Arrêt.");
  process.exit(1);
}
if (WEBHOOK_SECRET.length < 16) {
  console.error("[config] WEBHOOK_SECRET doit faire au moins 16 caractères. Arrêt.");
  process.exit(1);
}
if (!DOKPLOY_API_KEY && !GITHUB_OWNER && Object.keys(APP_MAP).length === 0) {
  console.error(
    "[config] Fournis DOKPLOY_API_KEY (recommandé) ou GITHUB_OWNER/APP_MAP. Arrêt."
  );
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.warn(
    "[config] PUBLIC_URL non défini : les liens GitHub continueront de pointer vers Dokploy, pas vers /deployments/:id."
  );
}
if (PUBLIC_URL && !DASHBOARD_PASSWORD) {
  console.warn(
    "[config] DASHBOARD_PASSWORD non défini : /deployments/:id ne sera accessible que via le lien signé posé sur GitHub, jamais en accès direct."
  );
}

const signer = makeSigner(WEBHOOK_SECRET);

// Construit l'URL de la page de détail d'un déploiement, avec un jeton signé
// qui n'autorise QUE ce déploiement (voir auth.js) — c'est ce jeton qui
// permet au clic "Details"/"View deployment" depuis GitHub de s'ouvrir sans
// écran de mot de passe, sans pour autant donner accès aux autres déploiements.
function buildDeploymentUrl(deploymentId) {
  if (!PUBLIC_URL) return null;
  const token = signer.sign(`deployment:${deploymentId}`, 60 * 60 * 24 * 90);
  return `${PUBLIC_URL}/deployments/${deploymentId}?t=${token}`;
}

const GITHUB_API = "https://api.github.com";

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

const STATE_MAP = {
  pending: { state: "pending", description: "Déploiement en cours..." },
  success: { state: "success", description: "Déployé avec succès ✅" },
  failure: { state: "failure", description: "Échec du déploiement ❌" },
  error: { state: "error", description: "Erreur ❌" },
};

const INPUT_STATUS = {
  running: "pending",
  pending: "pending",
  done: "success",
  success: "success",
  failed: "failure",
  failure: "failure",
  error: "error",
};

function toCommitState(state) {
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  return "failure";
}

function cleanUrl(value) {
  if (!value) return undefined;
  try {
    const u = new URL(String(value));
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    /* ignore */
  }
  return undefined;
}

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

// ---------- GitHub ----------

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "dokploy-github-status",
  };
}

async function githubFetchOnce(url, options) {
  const to = withTimeout(10000);
  let res;
  try {
    res = await fetch(url, { ...options, headers: githubHeaders(), signal: to.signal });
  } finally {
    to.done();
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`GitHub API ${res.status} sur ${url}`);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

// Bug 2 (statuts manquants) : un aléa réseau/5xx ponctuel ne doit pas suffire à
// perdre un statut définitivement. 2 tentatives supplémentaires, backoff court.
// Jamais de retry sur une erreur 4xx (permissions, payload invalide) : ça ne
// changera pas de résultat, autant échouer vite et le voir dans les logs.
async function githubFetch(url, options = {}, attempt = 0) {
  try {
    return await githubFetchOnce(url, options);
  } catch (err) {
    const retriable = !err.status || err.status >= 500;
    if (retriable && attempt < 2) {
      const delay = 500 * (attempt + 1);
      console.warn(
        `[github] tentative ${attempt + 1} échouée (${err.message}), nouvel essai dans ${delay}ms`
      );
      await new Promise((r) => setTimeout(r, delay));
      return githubFetch(url, options, attempt + 1);
    }
    throw err;
  }
}

const githubPost = (url, body) =>
  githubFetch(url, { method: "POST", body: JSON.stringify(body) });

async function getHeadSha(owner, repo, branch) {
  const data = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`
  );
  return data.sha;
}

// GitHub accepte "in_progress" pour un deployment status (pas pour un commit
// status, qui reste "pending") : plus juste sémantiquement que "pending" tout
// court pour un déploiement réellement en cours d'exécution.
function toDeploymentStatusState(state) {
  if (state === "pending") return "in_progress";
  return state; // success | failure | error
}

// url = URL publique de l'app (environment_url, "voir le site") ; logUrl =
// lien de secours vers les logs Dokploy si /deployments/:id n'est pas
// configuré (PUBLIC_URL absent) ; meta = infos d'affichage optionnelles
// (appName, environment) pour la page de détail.
async function setGithubStatus(owner, repo, sha, state, description, url, logUrl, meta = {}) {
  // Toujours clore un éventuel pending précédent sur ce repo avant d'agir,
  // qu'on pose un nouveau pending (commit court-circuité par un push plus
  // récent) ou un statut final — sinon un pending resterait bloqué si le
  // déploiement suivant saute directement à "success" sans repasser par nous.
  await closeStalePending(owner, repo, sha);

  const deployment = await githubPost(
    `${GITHUB_API}/repos/${owner}/${repo}/deployments`,
    { ref: sha, auto_merge: false, required_contexts: [], environment: meta.environment || "dokploy" }
  );
  console.log(`[github] deployment créé : id=${deployment.id}`);

  const deploymentId = String(deployment.id);
  const ownPageUrl = buildDeploymentUrl(deploymentId);
  const details = ownPageUrl || logUrl || url;

  if (store.get(deploymentId)) {
    store.update(deploymentId, state, description);
  } else {
    store.create(deploymentId, {
      owner,
      repo,
      sha,
      branch: meta.branch,
      appName: meta.appName,
      environment: meta.environment || "production",
      appUrl: url || null,
      dokployLogUrl: logUrl || null,
      status: state,
      description,
    });
  }

  await githubPost(
    `${GITHUB_API}/repos/${owner}/${repo}/deployments/${deployment.id}/statuses`,
    {
      state: toDeploymentStatusState(state),
      description,
      environment_url: url,
      log_url: details,
      auto_inactive: true,
    }
  );
  console.log(`[github] deployment status : state=${toDeploymentStatusState(state)}`);

  const commitState = toCommitState(state);
  await githubPost(`${GITHUB_API}/repos/${owner}/${repo}/statuses/${sha}`, {
    state: commitState,
    description,
    context: "Dokploy",
    target_url: details,
  });
  if (commitState === "pending") pendingByRepo.set(`${owner}/${repo}`, sha);
  else if (pendingByRepo.get(`${owner}/${repo}`) === sha) pendingByRepo.delete(`${owner}/${repo}`);
  console.log(`[github] commit status : state=${commitState}`);
}

// Bug 1 (pending qui ne se referment jamais) : Dokploy ne déploie que le
// dernier commit poussé sur la branche. Si un commit B arrive pendant que le
// pending de A tourne encore, A est court-circuité et son rond orange ne
// bougera plus jamais tout seul. On mémorise donc, par repo, le dernier sha
// mis en pending par ce service ; dès qu'un sha différent doit passer en
// pending (ou que le déploiement se termine), on referme l'ancien.
const pendingByRepo = new Map(); // "owner/repo" -> sha actuellement en pending posé par nous

async function closeStalePending(owner, repo, keepSha) {
  const key = `${owner}/${repo}`;
  const staleSha = pendingByRepo.get(key);
  if (!staleSha || staleSha === keepSha) return;
  try {
    await githubPost(`${GITHUB_API}/repos/${owner}/${repo}/statuses/${staleSha}`, {
      state: "success",
      description: "Remplacé par un déploiement plus récent",
      context: "Dokploy",
    });
    console.log(
      `[github] pending clos (court-circuité) : ${owner}/${repo} ${staleSha.slice(0, 7)}`
    );
  } catch (err) {
    // Le sha a pu disparaître (force-push, branche supprimée) : pas bloquant.
    console.warn(
      `[github] impossible de clore l'ancien pending ${staleSha.slice(0, 7)} : ${err.message}`
    );
  }
}

// ---------- Résolution du repo ----------

function parseGitUrl(gitUrl) {
  if (!gitUrl) return null;
  const m = String(gitUrl).match(
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:$|[/?#])/
  );
  return m ? { owner: m[1], repo: m[2] } : null;
}

// URL Dokploy : fournie par env, sinon apprise depuis le lien d'une notification
let dokployBase = DOKPLOY_URL;

async function dokployGet(path) {
  if (!DOKPLOY_API_KEY || !dokployBase) return null;
  const to = withTimeout(10000);
  let res;
  try {
    res = await fetch(`${dokployBase}${path}`, {
      headers: { "x-api-key": DOKPLOY_API_KEY, Accept: "application/json" },
      signal: to.signal,
    });
  } finally {
    to.done();
  }
  if (!res.ok) {
    const err = new Error(`Dokploy API ${res.status} sur ${path}`);
    err.detail = await res.text().catch(() => "");
    throw err;
  }
  return res.json();
}

// Extrait owner/repo/branch (+ nom d'app et URL publique, pour l'affichage
// sur /deployments/:id) d'un objet application Dokploy
function repoFromApp(a) {
  if (!a) return null;
  const appName = a.name || a.appName || null;
  const firstDomain = Array.isArray(a.domains) && a.domains[0] ? a.domains[0].host : null;
  const url = firstDomain ? `https://${firstDomain}` : null;
  if (a.owner && a.repository) {
    return { owner: a.owner, repo: a.repository, branch: a.branch || GITHUB_BRANCH, appName, url };
  }
  const parsed = parseGitUrl(a.customGitUrl || a.customGitBuildPath);
  if (parsed) return { ...parsed, branch: a.customGitBranch || GITHUB_BRANCH, appName, url };
  return null;
}

// Interroge l'API Dokploy pour connaître le repo GitHub d'une application
async function resolveViaDokploy(buildLink) {
  if (!DOKPLOY_API_KEY) return null;
  let appId;
  try {
    const u = new URL(buildLink);
    if (!dokployBase) {
      dokployBase = u.origin;
      startPoller();
    }
    const m = u.pathname.match(/\/application\/([^/?#]+)/);
    appId = m && m[1];
  } catch {
    return null;
  }
  if (!appId) return null;
  learnedAppIds.add(appId);
  const a = await dokployGet(
    `/api/application.one?applicationId=${encodeURIComponent(appId)}`
  );
  const repo = repoFromApp(a);
  appRepoCache.set(appId, repo);
  return repo;
}

function resolveViaConfig(appName) {
  const mapped = APP_MAP[appName];
  if (mapped) {
    const [full, branch] = String(mapped).split("@");
    const [owner, repo] = full.split("/");
    if (owner && repo) return { owner, repo, branch: branch || GITHUB_BRANCH };
  }
  if (GITHUB_OWNER && NAME_RE.test(appName)) {
    return { owner: GITHUB_OWNER, repo: appName, branch: GITHUB_BRANCH };
  }
  return null;
}

// ---------- Surveillance auto de Dokploy (statut "en cours") ----------

const POLL_ENABLED = (process.env.POLL || "on").toLowerCase() !== "off";
const POLL_INTERVAL_MS = Math.max(
  2000,
  Number(process.env.POLL_INTERVAL_MS) || 5000
);
// Fenêtre de rattrapage des statuts finaux manqués : ne concerne que les
// déploiements terminés il y a moins de X minutes (évite la "tempête" au
// redémarrage du service, où sinon tout l'historique récent de chaque app
// serait reposté d'un coup — voir pollOnce()).
const CATCHUP_MAX_AGE_MS = Math.max(
  60000,
  Number(process.env.CATCHUP_MAX_AGE_MS) || 15 * 60 * 1000
);
const seenDeployments = new Map(); // applicationId -> dernier deploymentId "en cours" traité
const seenFinal = new Map(); // applicationId -> dernier deploymentId final (done/error) déjà posté
const appRepoCache = new Map(); // applicationId -> {owner,repo,branch} | null
const learnedAppIds = new Set(); // ids vus via les notifications /webhook
let pollerStarted = false;

// Récupère (et met en cache) le repo GitHub d'une application via son id
async function getAppRepo(applicationId) {
  if (appRepoCache.has(applicationId)) return appRepoCache.get(applicationId);
  let repo = null;
  try {
    const a = await dokployGet(
      `/api/application.one?applicationId=${encodeURIComponent(applicationId)}`
    );
    repo = repoFromApp(a);
  } catch {
    /* app inaccessible / pas une application : on garde null */
  }
  appRepoCache.set(applicationId, repo);
  return repo;
}

// Parcourt récursivement la réponse project.all (project -> environments -> applications)
function walkAppIds(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) walkAppIds(item, out);
    return out;
  }
  if (
    typeof node.applicationId === "string" &&
    (node.appName || node.name || "applicationStatus" in node)
  ) {
    out.add(node.applicationId);
  }
  for (const v of Object.values(node)) walkAppIds(v, out);
  return out;
}

async function listAppIds() {
  const ids = new Set(learnedAppIds);
  try {
    const projects = await dokployGet("/api/project.all");
    for (const id of walkAppIds(projects)) ids.add(id);
  } catch (err) {
    console.warn("[poll] project.all indisponible :", err.message);
  }
  return ids;
}

// Le champ "description" d'un déploiement Dokploy vaut "Commit: <sha>" — bien
// plus fiable que "dernier commit de la branche" pour un rattrapage a
// posteriori (la branche a pu avancer depuis ce déploiement précis).
function shaFromDeployment(deployment) {
  const m = String(deployment?.description || "").match(/[0-9a-f]{7,40}/i);
  return m ? m[0] : null;
}

async function pollOnce() {
  const ids = await listAppIds();
  for (const id of ids) {
    const repo = await getAppRepo(id);
    if (!repo) continue;

    let deployments;
    try {
      deployments = await dokployGet(
        `/api/deployment.all?applicationId=${encodeURIComponent(id)}`
      );
    } catch {
      continue;
    }
    const latest = Array.isArray(deployments) ? deployments[0] : null;
    if (!latest) continue;
    const status = String(latest.status || "").toLowerCase();

    if (status === "running") {
      if (seenDeployments.get(id) === latest.deploymentId) continue;
      seenDeployments.set(id, latest.deploymentId);
      try {
        const sha = await getHeadSha(repo.owner, repo.repo, repo.branch);
        const mapped = STATE_MAP.pending;
        await setGithubStatus(
          repo.owner,
          repo.repo,
          sha,
          mapped.state,
          mapped.description,
          repo.url,
          dokployBase ? `${dokployBase}/dashboard/projects` : undefined,
          { appName: repo.appName, branch: repo.branch, environment: "production" }
        );
        console.log(
          `[poll] ${repo.owner}/${repo.repo} en cours -> pending (${sha.slice(0, 7)})`
        );
      } catch (err) {
        console.error("[poll] échec pending :", err.message);
      }
      continue;
    }

    // Bug 2 (statuts manquants) : filet de rattrapage. Si le webhook Dokploy
    // n'a jamais atteint ce service pour ce déploiement (down, retry réseau
    // épuisé, etc.), on pose ici le statut final a posteriori — idempotent
    // par deploymentId, donc sans risque de doublon avec un webhook qui a
    // bien fonctionné.
    if (status === "done" || status === "error") {
      if (seenFinal.get(id) === latest.deploymentId) continue;
      seenFinal.set(id, latest.deploymentId);
      // On a vu ce déploiement passer par "running" via ce même service : le
      // webhook Dokploy a de bonnes chances d'avoir déjà posté le statut
      // final normalement. On ne double-poste pas dans ce cas (bruit inutile
      // sur GitHub) — le rattrapage ne sert que pour les déploiements dont on
      // n'a JAMAIS eu la moindre nouvelle avant qu'ils se terminent.
      if (seenDeployments.get(id) === latest.deploymentId) continue;
      // Après un redémarrage du service, sa mémoire est vide : sans ce
      // garde-fou, TOUS les derniers déploiements de TOUTES les apps
      // paraîtraient "jamais vus" et se feraient reposter d'un coup, même
      // des commits vieux de plusieurs jours déjà correctement traités
      // avant le redémarrage. On ne rattrape que ce qui s'est réellement
      // terminé récemment.
      const finishedAt = new Date(
        latest.finishedAt || latest.startedAt || latest.createdAt || 0
      ).getTime();
      if (!finishedAt || Date.now() - finishedAt > CATCHUP_MAX_AGE_MS) continue;
      const sha = shaFromDeployment(latest);
      if (!sha) continue; // rien d'exploitable, pas de commit identifiable
      try {
        const mapped = STATE_MAP[status === "done" ? "success" : "failure"];
        await setGithubStatus(
          repo.owner,
          repo.repo,
          sha,
          mapped.state,
          mapped.description,
          repo.url,
          dokployBase ? `${dokployBase}/dashboard/projects` : undefined,
          { appName: repo.appName, branch: repo.branch, environment: "production" }
        );
        console.log(
          `[poll] rattrapage statut final : ${repo.owner}/${repo.repo} ${sha.slice(0, 7)} -> ${mapped.state}`
        );
      } catch (err) {
        console.error("[poll] échec rattrapage :", err.message);
      }
    }
  }
}

function startPoller() {
  if (pollerStarted || !POLL_ENABLED || !DOKPLOY_API_KEY || !dokployBase) return;
  pollerStarted = true;
  console.log(`[poll] surveillance Dokploy active (toutes les ${POLL_INTERVAL_MS} ms)`);
  const tick = () =>
    pollOnce().catch((err) => console.error("[poll] erreur :", err.message));
  tick();
  setInterval(tick, POLL_INTERVAL_MS).unref();
}

// ---------- Normalisation du payload ----------

function readStatus(body) {
  const raw = String(body.status || body.type || "").toLowerCase();
  const title = String(body.title || "").toLowerCase();
  if (INPUT_STATUS[raw] && raw !== "build" && raw !== "deploy")
    return INPUT_STATUS[raw];
  if (raw === "success" || title.includes("success")) return "success";
  if (raw === "error" || raw === "failed" || title.includes("fail"))
    return "failure";
  return undefined;
}

async function parsePayload(body = {}) {
  // Format manuel explicite
  if (body.githubOwner && body.githubRepo) {
    return {
      appName: body.appName,
      status: INPUT_STATUS[String(body.status).toLowerCase()],
      owner: body.githubOwner,
      repo: body.githubRepo,
      branch: body.branch || GITHUB_BRANCH,
      sha: body.sha,
      url: cleanUrl(body.appUrl),
      logUrl: cleanUrl(body.logUrl),
    };
  }

  // Format notification Dokploy
  const appName = body.applicationName || body.appName;
  if (!appName) return null;

  let repo = resolveViaConfig(appName);
  if (!repo) repo = await resolveViaDokploy(body.buildLink);
  if (!repo) return null;

  const firstDomain = String(body.domains || "").split(",")[0].trim();
  return {
    appName,
    status: readStatus(body),
    owner: repo.owner,
    repo: repo.repo,
    branch: repo.branch,
    sha: undefined,
    url: firstDomain ? `https://${firstDomain}` : undefined,
    logUrl: cleanUrl(body.buildLink),
  };
}

// ---------- Route ----------

app.post("/webhook", async (req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (!secret || !safeEqual(secret, WEBHOOK_SECRET)) {
    console.warn("[webhook] secret invalide -> 401");
    return res.status(401).json({ error: "Unauthorized" });
  }

  let intent;
  try {
    intent = await parsePayload(req.body);
  } catch (err) {
    console.error("[webhook] résolution repo échouée :", err.message, err.detail || "");
    return res.status(502).json({ error: "Résolution du repo impossible" });
  }

  if (!intent) {
    console.warn("[webhook] payload non reconnu / app inconnue -> 400");
    return res.status(400).json({ error: "Payload non reconnu / app inconnue" });
  }
  if (!intent.status) {
    console.log(`[webhook] app=${intent.appName} : événement ignoré`);
    return res.json({ ok: true, ignored: true });
  }
  if (!NAME_RE.test(intent.owner || "") || !NAME_RE.test(intent.repo || "")) {
    return res.status(400).json({ error: "owner/repo invalide" });
  }

  const mapped = STATE_MAP[intent.status];
  console.log(
    `[webhook] app=${intent.appName} status=${intent.status} -> ${mapped.state} (${intent.owner}/${intent.repo}@${intent.branch})`
  );

  try {
    let sha = intent.sha;
    if (!SHA_RE.test(sha || "")) {
      sha = await getHeadSha(intent.owner, intent.repo, intent.branch);
      console.log(`[webhook] SHA résolu : ${sha.slice(0, 7)}`);
    }
    await setGithubStatus(
      intent.owner,
      intent.repo,
      sha,
      mapped.state,
      mapped.description,
      intent.url,
      intent.logUrl,
      { appName: intent.appName, branch: intent.branch, environment: "production" }
    );
    console.log("[webhook] statuts GitHub mis à jour avec succès");
    return res.json({ ok: true, state: mapped.state });
  } catch (err) {
    console.error(
      "[webhook] erreur API GitHub :",
      err.message,
      JSON.stringify(err.detail || {})
    );
    return res.status(500).json({ error: "Échec de la mise à jour GitHub" });
  }
});

// Webhook GitHub "push" : pose le statut "en cours" dès le push (optionnel)
app.post("/github", async (req, res) => {
  if (!GITHUB_WEBHOOK_SECRET) return res.status(404).json({ error: "Non configuré" });

  const sig = req.headers["x-hub-signature-256"] || "";
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", GITHUB_WEBHOOK_SECRET)
      .update(req.rawBody || Buffer.alloc(0))
      .digest("hex");
  if (!safeEqual(sig, expected)) {
    console.warn("[github-push] signature invalide -> 401");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const event = req.headers["x-github-event"];
  if (event === "ping") return res.json({ ok: true, pong: true });
  if (event !== "push") return res.json({ ok: true, ignored: event });

  const body = req.body || {};
  if (body.deleted || !body.after || /^0+$/.test(body.after)) {
    return res.json({ ok: true, ignored: "branch supprimée" });
  }
  const owner = body.repository?.owner?.login || body.repository?.owner?.name;
  const repo = body.repository?.name;
  if (!NAME_RE.test(owner || "") || !NAME_RE.test(repo || "")) {
    return res.status(400).json({ error: "repo invalide" });
  }

  console.log(`[github-push] ${owner}/${repo} ${body.after.slice(0, 7)} -> pending`);
  try {
    const branch = String(body.ref || "").replace(/^refs\/heads\//, "") || undefined;
    const mapped = STATE_MAP.pending;
    await setGithubStatus(
      owner,
      repo,
      body.after,
      mapped.state,
      mapped.description,
      undefined,
      body.compare,
      { branch, environment: "production" }
    );
    return res.json({ ok: true, state: "pending" });
  } catch (err) {
    console.error("[github-push] erreur API GitHub :", err.message, JSON.stringify(err.detail || {}));
    return res.status(500).json({ error: "Échec de la mise à jour GitHub" });
  }
});

// ---------- Pages de détail des déploiements ----------

// Garde-fou anti brute-force sur le mot de passe : 5 essais/minute par IP.
// Volontairement simple (mémoire, pas de dépendance) — suffisant pour une
// page à usage interne, pas un endpoint public à fort trafic.
const loginAttempts = new Map(); // ip -> { count, resetAt }
function loginThrottled(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 60000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 5;
}

app.post("/api/login", (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res.status(503).json({ error: "Accès par mot de passe non configuré" });
  }
  if (loginThrottled(req.ip || "?")) {
    return res.status(429).json({ error: "Trop de tentatives, réessaie dans une minute." });
  }
  const password = req.body && req.body.password;
  if (typeof password !== "string" || !safeEqual(password, DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Mot de passe incorrect." });
  }
  const token = signer.sign("session", 60 * 60 * 24 * 30); // 30 jours
  res.json({ token });
});

const DEPLOYMENT_ID_RE = /^[0-9]+$/;

// Un jeton de session (mot de passe) donne accès à tous les déploiements ;
// un jeton de lien (posé sur GitHub) ne donne accès qu'au déploiement visé.
function isAuthorizedFor(req, id) {
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (bearer && signer.verify(bearer, "session")) return true;
  const linkToken = req.query.t || req.headers["x-link-token"];
  if (linkToken && signer.verify(String(linkToken), `deployment:${id}`)) return true;
  return false;
}

// Données du déploiement, jamais les secrets (token GitHub, clé Dokploy,
// mot de passe) : le store ne les contient de toute façon pas.
app.get("/api/deployments/:id", (req, res) => {
  const { id } = req.params;
  if (!DEPLOYMENT_ID_RE.test(id)) {
    return res.status(400).json({ error: "Identifiant de déploiement invalide" });
  }
  // Auth vérifiée AVANT de regarder si l'id existe : un visiteur non
  // authentifié reçoit toujours 401, jamais 404, pour ne pas laisser deviner
  // quels ids existent par simple essai-erreur.
  if (!isAuthorizedFor(req, id)) {
    return res.status(401).json({ error: "Authentification requise" });
  }
  const record = store.get(id);
  if (!record) return res.status(404).json({ error: "Déploiement introuvable" });
  res.json(record);
});

// Une seule page HTML pour tous les déploiements : le rendu (et
// l'authentification) se fait côté client via /api/deployments/:id, qui lui
// applique les vraies vérifications. Servir ce gabarit ne fuite donc rien.
app.get("/deployments/:id", (_req, res) => {
  res.type("html").send(renderDeploymentPage());
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Diagnostic du poller : GET /debug-poll?secret=<WEBHOOK_SECRET>
app.get("/debug-poll", async (req, res) => {
  if (!safeEqual(req.query.secret || "", WEBHOOK_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const out = { dokployBase, learnedAppIds: [...learnedAppIds], projectAll: null, apps: [] };
  try {
    out.projectAll = await dokployGet("/api/project.all");
  } catch (err) {
    out.projectAllError = err.message + " " + (err.detail || "");
  }
  const ids = await listAppIds();
  for (const id of ids) {
    const entry = { id };
    try {
      entry.app = await dokployGet(`/api/application.one?applicationId=${encodeURIComponent(id)}`);
      entry.repo = repoFromApp(entry.app);
    } catch (err) {
      entry.appError = err.message;
    }
    try {
      const d = await dokployGet(`/api/deployment.all?applicationId=${encodeURIComponent(id)}`);
      entry.latestDeployment = Array.isArray(d) ? d[0] : d;
    } catch (err) {
      entry.deploymentError = err.message;
    }
    out.apps.push(entry);
  }
  res.type("application/json").send(JSON.stringify(out, null, 2));
});

app.get("/", (_req, res) => {
  res
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><title>dokploy-github-status</title>` +
        `<style>body{font:14px system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem;color:#222}` +
        `code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}</style>` +
        `<h1>dokploy-github-status</h1>` +
        `<p>Service actif. Il met à jour les statuts de déploiement GitHub à partir des webhooks Dokploy.</p>` +
        `<ul><li><code>POST /webhook</code> — notification Dokploy</li>` +
        `<li><code>POST /github</code> — webhook GitHub push (statut « en cours »)</li>` +
        `<li><code>GET /deployments/:id</code> — page de détail d'un déploiement</li>` +
        `<li><code>GET /health</code></li></ul>`
    );
});

app.listen(PORT, () => {
  console.log(`dokploy-github-status en écoute sur le port ${PORT}`);
  startPoller(); // démarre si DOKPLOY_URL est connu ; sinon au 1er webhook reçu
});
