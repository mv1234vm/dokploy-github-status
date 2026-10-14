const crypto = require("crypto");
const path = require("path");
const express = require("express");
const store = require("./store");
const auditLog = require("./audit-log");
const mute = require("./mute");
const { makeSigner } = require("./auth");

const app = express();
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.static(path.join(__dirname, "public")));

const PORT = 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DOKPLOY_API_KEY = process.env.DOKPLOY_API_KEY || "";
const DOKPLOY_URL = (process.env.DOKPLOY_URL || "").replace(/\/+$/, "");
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
let DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const SELF_APPLICATION_ID = process.env.SELF_APPLICATION_ID || "";
const OUTGOING_WEBHOOK_URL = process.env.OUTGOING_WEBHOOK_URL || "";
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
  }
  return undefined;
}

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

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

function toDeploymentStatusState(state) {
  if (state === "pending") return "in_progress";
  return state;
}

async function setGithubStatus(owner, repo, sha, state, description, url, logUrl, meta = {}) {
  await closeStalePending(owner, repo, sha);

  const key = `${owner}/${repo}`;
  const open = pendingByRepo.get(key);
  let deploymentId;
  if (open && open.sha === sha) {
    deploymentId = open.deploymentId;
  } else {
    const deployment = await githubPost(
      `${GITHUB_API}/repos/${owner}/${repo}/deployments`,
      { ref: sha, auto_merge: false, required_contexts: [], environment: meta.environment || "dokploy" }
    );
    deploymentId = String(deployment.id);
    console.log(`[github] deployment créé : id=${deploymentId}`);
  }

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
      applicationId: meta.applicationId,
      environment: meta.environment || "production",
      appUrl: url || null,
      dokployLogUrl: logUrl || null,
      status: state,
      description,
    });
  }

  await githubPost(
    `${GITHUB_API}/repos/${owner}/${repo}/deployments/${deploymentId}/statuses`,
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
  if (commitState === "pending") pendingByRepo.set(key, { sha, deploymentId });
  else if (open && open.deploymentId === deploymentId) pendingByRepo.delete(key);
  console.log(`[github] commit status : state=${commitState}`);

  fireOutgoingWebhook({
    id: deploymentId,
    owner,
    repo,
    sha,
    branch: meta.branch || null,
    appName: meta.appName || null,
    environment: meta.environment || "production",
    status: state,
    description,
    url: details,
  });
}

function fireOutgoingWebhook(payload) {
  if (!OUTGOING_WEBHOOK_URL) return;
  const to = withTimeout(5000);
  fetch(OUTGOING_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: to.signal,
  })
    .catch((err) => console.warn("[outgoing-webhook] échec :", err.message))
    .finally(to.done);
}

const pendingByRepo = new Map();

async function closeStalePending(owner, repo, keepSha) {
  const key = `${owner}/${repo}`;
  const stale = pendingByRepo.get(key);
  if (!stale || stale.sha === keepSha) return;
  const label = "Remplacé par un déploiement plus récent";
  try {
    await githubPost(`${GITHUB_API}/repos/${owner}/${repo}/statuses/${stale.sha}`, {
      state: "success",
      description: label,
      context: "Dokploy",
    });
    console.log(
      `[github] pending clos (court-circuité) : ${owner}/${repo} ${stale.sha.slice(0, 7)}`
    );
  } catch (err) {
    console.warn(
      `[github] impossible de clore le commit status pending ${stale.sha.slice(0, 7)} : ${err.message}`
    );
  }
  try {
    await githubPost(
      `${GITHUB_API}/repos/${owner}/${repo}/deployments/${stale.deploymentId}/statuses`,
      { state: "inactive", description: label }
    );
  } catch (err) {
    console.warn(
      `[github] impossible de clore le deployment status pending id=${stale.deploymentId} : ${err.message}`
    );
  }
  if (store.get(stale.deploymentId)) store.update(stale.deploymentId, "success", label);
  pendingByRepo.delete(key);
}

function parseGitUrl(gitUrl) {
  if (!gitUrl) return null;
  const m = String(gitUrl).match(
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:$|[/?#])/
  );
  return m ? { owner: m[1], repo: m[2] } : null;
}

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

async function dokployPost(path, body) {
  if (!DOKPLOY_API_KEY || !dokployBase) throw new Error("Dokploy non configuré");
  const to = withTimeout(10000);
  let res;
  try {
    res = await fetch(`${dokployBase}${path}`, {
      method: "POST",
      headers: {
        "x-api-key": DOKPLOY_API_KEY,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body || {}),
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
  return res.json().catch(() => ({}));
}

function repoFromApp(a) {
  if (!a) return null;
  const appName = a.name || a.appName || null;
  const applicationId = a.applicationId || null;
  const firstDomain = Array.isArray(a.domains) && a.domains[0] ? a.domains[0].host : null;
  const url = firstDomain ? `https://${firstDomain}` : null;
  if (a.owner && a.repository) {
    return { owner: a.owner, repo: a.repository, branch: a.branch || GITHUB_BRANCH, appName, url, applicationId };
  }
  const parsed = parseGitUrl(a.customGitUrl || a.customGitBuildPath);
  if (parsed) return { ...parsed, branch: a.customGitBranch || GITHUB_BRANCH, appName, url, applicationId };
  return null;
}

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

const POLL_ENABLED = (process.env.POLL || "on").toLowerCase() !== "off";
const POLL_INTERVAL_MS = Math.max(
  2000,
  Number(process.env.POLL_INTERVAL_MS) || 5000
);
const CATCHUP_MAX_AGE_MS = Math.max(
  60000,
  Number(process.env.CATCHUP_MAX_AGE_MS) || 15 * 60 * 1000
);
const seenDeployments = new Map();
const seenFinal = new Map();
const appRepoCache = new Map();
const learnedAppIds = new Set();
let pollerStarted = false;

async function getAppRepo(applicationId) {
  if (appRepoCache.has(applicationId)) return appRepoCache.get(applicationId);
  try {
    const a = await dokployGet(
      `/api/application.one?applicationId=${encodeURIComponent(applicationId)}`
    );
    const repo = repoFromApp(a);
    appRepoCache.set(applicationId, repo);
    return repo;
  } catch (err) {
    console.warn(`[poll] résolution de l'app ${applicationId} échouée, retentera au prochain tick :`, err.message);
    return null;
  }
}

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

let pollFailureStreak = 0;
let lastPollError = null;
const POLL_ALERT_THRESHOLD = 5;

async function listAppIds() {
  const ids = new Set(learnedAppIds);
  try {
    const projects = await dokployGet("/api/project.all");
    for (const id of walkAppIds(projects)) ids.add(id);
    if (pollFailureStreak >= POLL_ALERT_THRESHOLD) {
      console.log("[poll] project.all de nouveau disponible, reprise normale");
    }
    pollFailureStreak = 0;
    lastPollError = null;
  } catch (err) {
    pollFailureStreak += 1;
    lastPollError = err.message;
    if (pollFailureStreak === POLL_ALERT_THRESHOLD) {
      console.error(
        `[poll] ALERTE : project.all échoue depuis ${POLL_ALERT_THRESHOLD} tentatives consécutives (${err.message}) — vérifie DOKPLOY_API_KEY / DOKPLOY_URL`
      );
    } else {
      console.warn("[poll] project.all indisponible :", err.message);
    }
  }
  return ids;
}

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
    } catch (err) {
      console.warn(`[poll] deployment.all indisponible pour ${repo.owner}/${repo.repo} :`, err.message);
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
          { appName: repo.appName, branch: repo.branch, environment: "production", applicationId: repo.applicationId }
        );
        console.log(
          `[poll] ${repo.owner}/${repo.repo} en cours -> pending (${sha.slice(0, 7)})`
        );
      } catch (err) {
        console.error("[poll] échec pending :", err.message);
      }
      continue;
    }

    if (status === "done" || status === "error") {
      if (seenFinal.get(id) === latest.deploymentId) continue;
      const finishedAt = new Date(
        latest.finishedAt || latest.startedAt || latest.createdAt || 0
      ).getTime();
      if (!finishedAt || Date.now() - finishedAt > CATCHUP_MAX_AGE_MS) {
        seenFinal.set(id, latest.deploymentId);
        continue;
      }
      const WEBHOOK_GRACE_MS = 90 * 1000;
      if (
        seenDeployments.get(id) === latest.deploymentId &&
        Date.now() - finishedAt < WEBHOOK_GRACE_MS
      ) {
        continue;
      }
      seenFinal.set(id, latest.deploymentId);
      const sha = shaFromDeployment(latest);
      if (!sha) continue;
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
          { appName: repo.appName, branch: repo.branch, environment: "production", applicationId: repo.applicationId }
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
      applicationId: null,
    };
  }

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
    applicationId: repo.applicationId || null,
  };
}

const webhookAttempts = new Map();
const WEBHOOK_RATE_LIMIT = 60;
function webhookThrottled(ip) {
  const now = Date.now();
  const entry = webhookAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    webhookAttempts.set(ip, { count: 1, resetAt: now + 60000 });
    return false;
  }
  entry.count += 1;
  return entry.count > WEBHOOK_RATE_LIMIT;
}

app.post("/webhook", async (req, res) => {
  if (webhookThrottled(req.ip || "?")) {
    return res.status(429).json({ error: "Trop de requêtes, réessaie dans une minute." });
  }
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
      { appName: intent.appName, branch: intent.branch, environment: "production", applicationId: intent.applicationId }
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

app.post("/github", async (req, res) => {
  if (webhookThrottled(req.ip || "?")) {
    return res.status(429).json({ error: "Trop de requêtes, réessaie dans une minute." });
  }
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

const loginAttempts = new Map();
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
    auditLog.record("login_failure", { ip: req.ip || "?" });
    return res.status(401).json({ error: "Mot de passe incorrect." });
  }
  auditLog.record("login_success", { ip: req.ip || "?" });
  const token = signer.sign("session", 60 * 60 * 24 * 30);
  res.json({ token });
});

const DEPLOYMENT_ID_RE = /^[0-9]+$/;

function isAuthorizedFor(req, id) {
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (bearer && signer.verify(bearer, "session")) return true;
  const linkToken = req.query.t || req.headers["x-link-token"];
  if (linkToken && signer.verify(String(linkToken), `deployment:${id}`)) return true;
  return false;
}

function isSessionAuthorized(req) {
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  return !!(bearer && signer.verify(bearer, "session"));
}

app.get("/api/deployments/:id", (req, res) => {
  const { id } = req.params;
  if (!DEPLOYMENT_ID_RE.test(id)) {
    return res.status(400).json({ error: "Identifiant de déploiement invalide" });
  }
  if (!isAuthorizedFor(req, id)) {
    return res.status(401).json({ error: "Authentification requise" });
  }
  const record = store.get(id);
  if (!record) return res.status(404).json({ error: "Déploiement introuvable" });
  res.json({ ...record, previousSha: store.previousSha(record) });
});

app.get("/deployments/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "deployment.html"));
});

const VALID_STATUSES = new Set(["pending", "success", "failure", "error"]);

app.get("/api/deployments", (req, res) => {
  if (!isSessionAuthorized(req)) {
    return res.status(401).json({ error: "Authentification requise" });
  }
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const status = VALID_STATUSES.has(req.query.status) ? req.query.status : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.slice(0, 200) : undefined;
  const { total, items } = store.list(limit, offset, { status, search });
  res.json({
    deployments: items,
    total,
    limit,
    offset,
    health: store.latestByRepo(),
    stats: store.statsByRepo(),
    mutedRepos: mute.list(),
  });
});

const retryAttempts = new Map();
const RETRY_COOLDOWN_MS = 30000;
function retryThrottled(applicationId) {
  const last = retryAttempts.get(applicationId);
  const now = Date.now();
  if (last && now - last < RETRY_COOLDOWN_MS) return RETRY_COOLDOWN_MS - (now - last);
  retryAttempts.set(applicationId, now);
  return 0;
}

app.post("/api/deployments/:id/retry", async (req, res) => {
  if (!isSessionAuthorized(req)) {
    return res.status(401).json({ error: "Authentification requise" });
  }
  const { id } = req.params;
  if (!DEPLOYMENT_ID_RE.test(id)) {
    return res.status(400).json({ error: "Identifiant de déploiement invalide" });
  }
  const record = store.get(id);
  if (!record) return res.status(404).json({ error: "Déploiement introuvable" });
  if (!record.applicationId) {
    return res.status(409).json({ error: "applicationId inconnu pour ce déploiement, relance impossible" });
  }
  const waitMs = retryThrottled(record.applicationId);
  if (waitMs > 0) {
    return res.status(429).json({ error: `Relance déjà lancée récemment, réessaie dans ${Math.ceil(waitMs / 1000)} s` });
  }
  try {
    await dokployPost("/api/application.deploy", { applicationId: record.applicationId });
    auditLog.record("retry", { ip: req.ip || "?", deploymentId: id, owner: record.owner, repo: record.repo });
    res.json({ ok: true });
  } catch (err) {
    console.error("[retry] échec relance Dokploy :", err.message, err.detail || "");
    res.status(502).json({ error: "Échec de la relance Dokploy" });
  }
});

const VALID_AUDIT_TYPES = new Set(["login_success", "login_failure", "retry", "password_change"]);

app.get("/api/audit-log", (req, res) => {
  if (!isSessionAuthorized(req)) {
    return res.status(401).json({ error: "Authentification requise" });
  }
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const type = VALID_AUDIT_TYPES.has(req.query.type) ? req.query.type : undefined;
  const ip = typeof req.query.ip === "string" ? req.query.ip.slice(0, 64) : undefined;
  const since = typeof req.query.since === "string" ? req.query.since.slice(0, 32) : undefined;
  res.json({ entries: auditLog.list(limit, { type, ip, since }) });
});

app.get("/api/webhook-config", (req, res) => {
  if (!isSessionAuthorized(req)) {
    return res.status(401).json({ error: "Authentification requise" });
  }
  const webhookUrl = PUBLIC_URL ? `${PUBLIC_URL}/webhook` : "https://<ton-domaine>/webhook";
  const curl =
    `curl -X POST ${webhookUrl} \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \\\n` +
    `  -d '{\n` +
    `    "appName": "mon-app",\n` +
    `    "status": "done",\n` +
    `    "sha": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",\n` +
    `    "githubOwner": "mv1234vm",\n` +
    `    "githubRepo": "mon-repo",\n` +
    `    "appUrl": "https://mon-app.exemple.fr"\n` +
    `  }'`;
  res.json({ webhookUrl, webhookSecretHeader: `x-webhook-secret: ${WEBHOOK_SECRET}`, curl });
});

app.post("/api/change-password", async (req, res) => {
  if (!isSessionAuthorized(req)) {
    return res.status(401).json({ error: "Authentification requise" });
  }
  if (!DASHBOARD_PASSWORD) {
    return res.status(503).json({ error: "Accès par mot de passe non configuré" });
  }
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || !safeEqual(currentPassword, DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Mot de passe actuel incorrect" });
  }
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit faire au moins 8 caractères" });
  }
  const previous = DASHBOARD_PASSWORD;
  DASHBOARD_PASSWORD = newPassword;
  auditLog.record("password_change", { ip: req.ip || "?" });

  if (!SELF_APPLICATION_ID || !DOKPLOY_API_KEY) {
    return res.json({
      ok: true,
      warning:
        "SELF_APPLICATION_ID non configuré : le changement n'est actif qu'en mémoire et sera perdu au prochain redéploiement. Mets aussi à jour DASHBOARD_PASSWORD dans l'environnement Dokploy pour le rendre définitif.",
    });
  }
  try {
    const currentEnv = await dokployGet(`/api/application.one?applicationId=${encodeURIComponent(SELF_APPLICATION_ID)}`);
    if (!currentEnv || typeof currentEnv.env !== "string") {
      throw new Error("Impossible de lire l'environnement actuel depuis Dokploy (API indisponible ou URL Dokploy pas encore connue)");
    }
    const lines = currentEnv.env
      .split("\n")
      .filter((l) => l && !l.startsWith("DASHBOARD_PASSWORD="));
    lines.push(`DASHBOARD_PASSWORD=${newPassword}`);
    await dokployPost("/api/application.update", {
      applicationId: SELF_APPLICATION_ID,
      env: lines.join("\n"),
    });
    res.json({ ok: true });
  } catch (err) {
    DASHBOARD_PASSWORD = previous;
    console.error("[change-password] échec de la mise à jour Dokploy :", err.message, err.detail || "");
    res.status(502).json({
      error: "Échec de l'écriture dans l'environnement Dokploy, mot de passe inchangé",
    });
  }
});

app.post("/api/repos/:owner/:repo/mute", (req, res) => {
  if (!isSessionAuthorized(req)) {
    return res.status(401).json({ error: "Authentification requise" });
  }
  const { owner, repo } = req.params;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) {
    return res.status(400).json({ error: "owner/repo invalide" });
  }
  const nowMuted = mute.toggle(`${owner}/${repo}`);
  res.json({ ok: true, muted: nowMuted });
});

app.get("/deployments", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin.html"));
});

app.get("/health", (_req, res) =>
  res.json({
    ok: pollFailureStreak < POLL_ALERT_THRESHOLD,
    pollFailureStreak,
    lastPollError,
  })
);

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
  res.sendFile(path.join(__dirname, "views", "landing.html"));
});

app.listen(PORT, () => {
  console.log(`dokploy-github-status en écoute sur le port ${PORT}`);
  startPoller();
});

function shutdown(signal) {
  console.log(`[server] ${signal} reçu, sauvegarde avant arrêt`);
  store.flush();
  auditLog.flush();
  mute.flush();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
