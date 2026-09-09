const crypto = require("crypto");
const express = require("express");

const app = express();
// Limite la taille du body pour éviter les abus / DoS
app.use(express.json({ limit: "16kb" }));
app.disable("x-powered-by");

const PORT = 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// On refuse de démarrer sans configuration : évite un service ouvert par erreur
if (!GITHUB_TOKEN || !WEBHOOK_SECRET) {
  console.error(
    "[config] GITHUB_TOKEN et WEBHOOK_SECRET sont obligatoires. Arrêt."
  );
  process.exit(1);
}
if (WEBHOOK_SECRET.length < 16) {
  console.error("[config] WEBHOOK_SECRET doit faire au moins 16 caractères. Arrêt.");
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

// Autorise uniquement "owner/repo" au format GitHub (pas de path traversal ni d'URL)
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

// Mapping status Dokploy -> GitHub (deployment status state + description)
const STATUS_MAP = {
  running: { state: "pending", description: "Déploiement en cours..." },
  done: { state: "success", description: "Déployé avec succès ✅" },
  failed: { state: "failure", description: "Échec du déploiement ❌" },
  error: { state: "error", description: "Erreur ❌" },
};

// Conversion pour l'API commit statuses (états supportés : pending/success/failure/error)
function toCommitState(state) {
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  return "failure";
}

// Valide et normalise une URL http(s) ; renvoie undefined si invalide
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

async function githubRequest(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: githubHeaders(),
      body: JSON.stringify(body),
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
    // On logge le détail côté serveur uniquement, jamais renvoyé au client
    const err = new Error(`GitHub API ${res.status} sur ${url}`);
    err.status = res.status;
    err.detail = data;
    throw err;
  }

  return data;
}

async function setGithubStatus(owner, repo, sha, state, description, url) {
  // 1. Créer un deployment
  const deployment = await githubRequest(
    `${GITHUB_API}/repos/${owner}/${repo}/deployments`,
    { ref: sha, auto_merge: false, required_contexts: [] }
  );
  console.log(`[github] deployment créé : id=${deployment.id}`);

  // 2. Créer un deployment status
  await githubRequest(
    `${GITHUB_API}/repos/${owner}/${repo}/deployments/${deployment.id}/statuses`,
    { state, description, environment_url: url, auto_inactive: true }
  );
  console.log(`[github] deployment status mis à jour : state=${state}`);

  // 3. Créer un commit status
  const commitState = toCommitState(state);
  await githubRequest(`${GITHUB_API}/repos/${owner}/${repo}/statuses/${sha}`, {
    state: commitState,
    description,
    context: "Dokploy",
    target_url: url,
  });
  console.log(`[github] commit status mis à jour : state=${commitState}`);
}

app.post("/webhook", async (req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (!secret || !safeEqual(secret, WEBHOOK_SECRET)) {
    console.warn("[webhook] secret invalide -> 401");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { appName, status, sha, githubOwner, githubRepo, appUrl } =
    req.body || {};

  if (!NAME_RE.test(githubOwner || "") || !NAME_RE.test(githubRepo || "")) {
    return res.status(400).json({ error: "githubOwner/githubRepo invalide" });
  }
  if (!SHA_RE.test(sha || "")) {
    return res.status(400).json({ error: "sha invalide" });
  }
  const mapped = STATUS_MAP[status];
  if (!mapped) {
    return res.status(400).json({ error: `Status inconnu : ${status}` });
  }

  const safeApp = typeof appName === "string" ? appName.slice(0, 100) : "?";
  console.log(
    `[webhook] reçu : app=${safeApp} status=${status} repo=${githubOwner}/${githubRepo} sha=${sha.slice(0, 7)}`
  );

  try {
    await setGithubStatus(
      githubOwner,
      githubRepo,
      sha,
      mapped.state,
      mapped.description,
      cleanUrl(appUrl)
    );
    console.log("[webhook] statuts GitHub mis à jour avec succès");
    return res.json({ ok: true, state: mapped.state });
  } catch (err) {
    console.error(
      "[webhook] erreur API GitHub :",
      err.message,
      JSON.stringify(err.detail || {})
    );
    // Message générique : aucun détail interne renvoyé au client
    return res.status(500).json({ error: "Échec de la mise à jour GitHub" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Route de diagnostic : mémorise le dernier payload reçu (à retirer ensuite)
let lastDebug = null;
app.post("/debug", (req, res) => {
  lastDebug = {
    receivedAt: new Date().toISOString(),
    headers: req.headers,
    body: req.body,
  };
  console.log("[debug] payload reçu :", JSON.stringify(lastDebug, null, 2));
  res.json({ ok: true });
});
app.get("/debug", (_req, res) => {
  res
    .type("text/plain")
    .send(
      lastDebug
        ? JSON.stringify(lastDebug, null, 2)
        : "Aucun payload reçu pour l'instant. Déclenche un déploiement dans Dokploy."
    );
});

app.listen(PORT, () => {
  console.log(`dokploy-github-status en écoute sur le port ${PORT}`);
});
