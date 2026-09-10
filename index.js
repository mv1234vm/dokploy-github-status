const crypto = require("crypto");
const express = require("express");

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

async function githubFetch(url, options = {}) {
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

const githubPost = (url, body) =>
  githubFetch(url, { method: "POST", body: JSON.stringify(body) });

async function getHeadSha(owner, repo, branch) {
  const data = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`
  );
  return data.sha;
}

// url = URL publique de l'app (environment_url) ; logUrl = page de logs Dokploy ("Details")
async function setGithubStatus(owner, repo, sha, state, description, url, logUrl) {
  const details = logUrl || url;

  const deployment = await githubPost(
    `${GITHUB_API}/repos/${owner}/${repo}/deployments`,
    { ref: sha, auto_merge: false, required_contexts: [], environment: "dokploy" }
  );
  console.log(`[github] deployment créé : id=${deployment.id}`);

  await githubPost(
    `${GITHUB_API}/repos/${owner}/${repo}/deployments/${deployment.id}/statuses`,
    {
      state,
      description,
      environment_url: url,
      log_url: details,
      auto_inactive: true,
    }
  );
  console.log(`[github] deployment status : state=${state}`);

  const commitState = toCommitState(state);
  await githubPost(`${GITHUB_API}/repos/${owner}/${repo}/statuses/${sha}`, {
    state: commitState,
    description,
    context: "Dokploy",
    target_url: details,
  });
  console.log(`[github] commit status : state=${commitState}`);
}

// Pose uniquement un commit status (utilisé par le webhook GitHub "push" -> en cours)
async function setPendingStatus(owner, repo, sha, targetUrl) {
  await githubPost(`${GITHUB_API}/repos/${owner}/${repo}/statuses/${sha}`, {
    state: "pending",
    description: STATE_MAP.pending.description,
    context: "Dokploy",
    target_url: targetUrl,
  });
  console.log(`[github] commit status : state=pending (${owner}/${repo} ${sha.slice(0, 7)})`);
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

// Extrait owner/repo/branch d'un objet application Dokploy
function repoFromApp(a) {
  if (!a) return null;
  if (a.owner && a.repository) {
    return { owner: a.owner, repo: a.repository, branch: a.branch || GITHUB_BRANCH };
  }
  const parsed = parseGitUrl(a.customGitUrl || a.customGitBuildPath);
  if (parsed) return { ...parsed, branch: a.customGitBranch || GITHUB_BRANCH };
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
  const a = await dokployGet(
    `/api/application.one?applicationId=${encodeURIComponent(appId)}`
  );
  return repoFromApp(a);
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
const seenDeployments = new Map(); // applicationId -> dernier deploymentId "en cours" traité
let pollerStarted = false;

function collectApplications(projects) {
  const apps = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    for (const a of p.applications || []) apps.push(a);
  }
  return apps;
}

async function pollOnce() {
  const projects = await dokployGet("/api/project.all");
  if (!projects) return;

  for (const app of collectApplications(projects)) {
    const id = app.applicationId;
    if (!id) continue;
    const repo = repoFromApp(app);
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
    if (status !== "running") continue;
    if (seenDeployments.get(id) === latest.deploymentId) continue;
    seenDeployments.set(id, latest.deploymentId);

    try {
      const sha = await getHeadSha(repo.owner, repo.repo, repo.branch);
      const target = dokployBase
        ? `${dokployBase}/dashboard/project`
        : undefined;
      await setPendingStatus(repo.owner, repo.repo, sha, target);
      console.log(
        `[poll] ${app.name || app.appName} en cours -> pending (${repo.owner}/${repo.repo} ${sha.slice(0, 7)})`
      );
    } catch (err) {
      console.error("[poll] échec pending :", err.message);
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
      intent.logUrl
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
    await setPendingStatus(owner, repo, body.after, body.compare);
    return res.json({ ok: true, state: "pending" });
  } catch (err) {
    console.error("[github-push] erreur API GitHub :", err.message, JSON.stringify(err.detail || {}));
    return res.status(500).json({ error: "Échec de la mise à jour GitHub" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

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
        `<li><code>GET /health</code></li></ul>`
    );
});

app.listen(PORT, () => {
  console.log(`dokploy-github-status en écoute sur le port ${PORT}`);
  startPoller(); // démarre si DOKPLOY_URL est connu ; sinon au 1er webhook reçu
});
