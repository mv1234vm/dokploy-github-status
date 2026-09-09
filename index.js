const crypto = require("crypto");
const express = require("express");

const app = express();
// Limite la taille du body pour éviter les abus / DoS
app.use(express.json({ limit: "16kb" }));
app.disable("x-powered-by");

const PORT = 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
// Compte GitHub par défaut : on suppose repo = nom de l'app Dokploy
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
// Exceptions : {"nom-app-dokploy":"owner/repo"} ou {"nom-app":"owner/repo@branche"}
let APP_MAP = {};
try {
  APP_MAP = process.env.APP_MAP ? JSON.parse(process.env.APP_MAP) : {};
} catch {
  console.error("[config] APP_MAP n'est pas un JSON valide. Ignoré.");
}

// On refuse de démarrer sans configuration : évite un service ouvert par erreur
if (!GITHUB_TOKEN || !WEBHOOK_SECRET) {
  console.error("[config] GITHUB_TOKEN et WEBHOOK_SECRET sont obligatoires. Arrêt.");
  process.exit(1);
}
if (WEBHOOK_SECRET.length < 16) {
  console.error("[config] WEBHOOK_SECRET doit faire au moins 16 caractères. Arrêt.");
  process.exit(1);
}
if (!GITHUB_OWNER && Object.keys(APP_MAP).length === 0) {
  console.error(
    "[config] Renseigne GITHUB_OWNER (ou APP_MAP) pour identifier les repos. Arrêt."
  );
  process.exit(1);
}

const GITHUB_API = "https://api.github.com";

// Comparaison à temps constant pour éviter les attaques par timing
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

// status logique -> state GitHub + description
const STATE_MAP = {
  pending: { state: "pending", description: "Déploiement en cours..." },
  success: { state: "success", description: "Déployé avec succès ✅" },
  failure: { state: "failure", description: "Échec du déploiement ❌" },
  error: { state: "error", description: "Erreur ❌" },
};

// Formats acceptés en entrée -> status logique
const INPUT_STATUS = {
  running: "pending",
  pending: "pending",
  done: "success",
  success: "success",
  failed: "failure",
  failure: "failure",
  error: "error",
};

// L'API commit statuses n'accepte pas "error" comme distinct utile ici
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

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "dokploy-github-status",
  };
}

async function githubFetch(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: githubHeaders(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
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

// Résout le repo GitHub à partir du nom d'app Dokploy
function resolveRepo(appName) {
  const mapped = APP_MAP[appName];
  if (mapped) {
    const [full, branch] = String(mapped).split("@");
    const [owner, repo] = full.split("/");
    return { owner, repo, branch: branch || GITHUB_BRANCH };
  }
  if (GITHUB_OWNER && NAME_RE.test(appName)) {
    return { owner: GITHUB_OWNER, repo: appName, branch: GITHUB_BRANCH };
  }
  return null;
}

// Récupère le SHA du dernier commit d'une branche
async function getHeadSha(owner, repo, branch) {
  const data = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
    { method: "GET" }
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

// Normalise n'importe quel payload (Dokploy ou manuel) en une intention commune
function parsePayload(body = {}) {
  // Format manuel documenté
  if (body.githubOwner && body.githubRepo) {
    return {
      appName: body.appName,
      status: INPUT_STATUS[String(body.status).toLowerCase()],
      owner: body.githubOwner,
      repo: body.githubRepo,
      branch: GITHUB_BRANCH,
      sha: body.sha,
      url: cleanUrl(body.appUrl),
    };
  }

  // Format notification Dokploy
  const appName = body.applicationName || body.appName;
  if (!appName) return null;
  const repo = resolveRepo(appName);
  if (!repo) return null;

  const raw = String(body.status || body.type || "").toLowerCase();
  const title = String(body.title || "").toLowerCase();
  let status;
  if (raw === "success" || title.includes("success")) status = "success";
  else if (raw === "error" || raw === "failed" || title.includes("fail"))
    status = "failure";

  const firstDomain = String(body.domains || "").split(",")[0].trim();

  return {
    appName,
    status,
    owner: repo.owner,
    repo: repo.repo,
    branch: repo.branch,
    sha: undefined, // Dokploy ne le fournit pas -> récupéré via l'API
    url: firstDomain ? `https://${firstDomain}` : undefined,
  };
}

app.post("/webhook", async (req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (!secret || !safeEqual(secret, WEBHOOK_SECRET)) {
    console.warn("[webhook] secret invalide -> 401");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const intent = parsePayload(req.body);
  if (!intent) {
    console.warn("[webhook] payload non reconnu -> 400");
    return res.status(400).json({ error: "Payload non reconnu / app inconnue" });
  }
  if (!intent.status) {
    // Événement neutre (build démarré, etc.) : on accuse réception sans agir
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
      console.log(`[webhook] SHA résolu via API : ${sha.slice(0, 7)}`);
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
