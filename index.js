const crypto = require("crypto");
const express = require("express");

const app = express();
app.use(express.json({ limit: "16kb" }));
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

async function setGithubStatus(owner, repo, sha, state, description, url) {
  const deployment = await githubPost(
    `${GITHUB_API}/repos/${owner}/${repo}/deployments`,
    { ref: sha, auto_merge: false, required_contexts: [] }
  );
  console.log(`[github] deployment créé : id=${deployment.id}`);

  await githubPost(
    `${GITHUB_API}/repos/${owner}/${repo}/deployments/${deployment.id}/statuses`,
    { state, description, environment_url: url, auto_inactive: true }
  );
  console.log(`[github] deployment status : state=${state}`);

  const commitState = toCommitState(state);
  await githubPost(`${GITHUB_API}/repos/${owner}/${repo}/statuses/${sha}`, {
    state: commitState,
    description,
    context: "Dokploy",
    target_url: url,
  });
  console.log(`[github] commit status : state=${commitState}`);
}

// ---------- Résolution du repo ----------

function parseGitUrl(gitUrl) {
  if (!gitUrl) return null;
  const m = String(gitUrl).match(
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:$|[/?#])/
  );
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Interroge l'API Dokploy pour connaître le repo GitHub d'une application
async function resolveViaDokploy(buildLink) {
  if (!DOKPLOY_API_KEY) return null;
  let base = DOKPLOY_URL;
  let appId;
  try {
    const u = new URL(buildLink);
    if (!base) base = u.origin;
    const m = u.pathname.match(/\/application\/([^/?#]+)/);
    appId = m && m[1];
  } catch {
    return null;
  }
  if (!base || !appId) return null;

  const to = withTimeout(10000);
  let res;
  try {
    res = await fetch(
      `${base}/api/application.one?applicationId=${encodeURIComponent(appId)}`,
      { headers: { "x-api-key": DOKPLOY_API_KEY, Accept: "application/json" }, signal: to.signal }
    );
  } finally {
    to.done();
  }
  if (!res.ok) {
    const err = new Error(`Dokploy API ${res.status}`);
    err.detail = await res.text().catch(() => "");
    throw err;
  }
  const a = await res.json();

  // Source GitHub native
  if (a.owner && a.repository) {
    return { owner: a.owner, repo: a.repository, branch: a.branch || GITHUB_BRANCH };
  }
  // Source "git" personnalisée
  const parsed = parseGitUrl(a.customGitUrl || a.customGitBuildPath);
  if (parsed) {
    return { ...parsed, branch: a.customGitBranch || GITHUB_BRANCH };
  }
  return null;
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
      intent.url
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

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`dokploy-github-status en écoute sur le port ${PORT}`);
});
