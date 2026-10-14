const path = require("path");
const { readJson, makeDebouncedWriter } = require("./json-file");

const MAX_RECORDS = 300;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "deployments.json");

const records = new Map();
const insertionOrder = [];

const FINAL_STATUSES = new Set(["success", "failure", "error"]);

for (const record of readJson(DATA_FILE, [])) {
  if (!record || typeof record.id !== "string") continue;
  records.set(record.id, record);
  insertionOrder.push(record.id);
}
if (records.size) console.log(`[store] ${records.size} déploiement(s) rechargé(s) depuis ${DATA_FILE}`);

const persist = makeDebouncedWriter("store", DATA_DIR, DATA_FILE, () =>
  insertionOrder.map((id) => records.get(id)).filter(Boolean)
);

function create(id, fields) {
  const now = new Date().toISOString();
  const record = {
    id,
    owner: fields.owner,
    repo: fields.repo,
    sha: fields.sha,
    branch: fields.branch || null,
    appName: fields.appName || null,
    applicationId: fields.applicationId || null,
    environment: fields.environment || "production",
    appUrl: fields.appUrl || null,
    dokployLogUrl: fields.dokployLogUrl || null,
    status: fields.status,
    description: fields.description,
    createdAt: now,
    updatedAt: now,
    finishedAt: FINAL_STATUSES.has(fields.status) ? now : null,
    history: [{ status: fields.status, description: fields.description, at: now }],
  };
  records.set(id, record);
  insertionOrder.push(id);
  if (insertionOrder.length > MAX_RECORDS) {
    const oldest = insertionOrder.shift();
    records.delete(oldest);
  }
  persist();
  return record;
}

function update(id, status, description) {
  const record = records.get(id);
  if (!record) return null;
  const now = new Date().toISOString();
  record.status = status;
  record.description = description;
  record.updatedAt = now;
  if (FINAL_STATUSES.has(status)) record.finishedAt = now;
  record.history.push({ status, description, at: now });
  persist();
  return record;
}

function get(id) {
  return records.get(id) || null;
}

function list(limit = 100, offset = 0, filters = {}) {
  let all = insertionOrder
    .slice()
    .reverse()
    .map((id) => records.get(id))
    .filter(Boolean);
  if (filters.status) all = all.filter((r) => r.status === filters.status);
  if (filters.search) {
    const q = filters.search.toLowerCase();
    all = all.filter((r) =>
      `${r.owner}/${r.repo} ${r.appName || ""}`.toLowerCase().includes(q)
    );
  }
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

function latestByRepo() {
  const map = new Map();
  for (const id of insertionOrder) {
    const record = records.get(id);
    if (!record) continue;
    const key = `${record.owner}/${record.repo}`;
    const current = map.get(key);
    if (!current || record.updatedAt >= current.updatedAt) map.set(key, record);
  }
  return [...map.values()].sort((a, b) => (a.repo > b.repo ? 1 : -1));
}

const SPARKLINE_DAYS = 14;
const STATS_SAMPLE = 20;

function statsByRepo() {
  const byRepo = new Map();
  for (let i = insertionOrder.length - 1; i >= 0; i--) {
    const record = records.get(insertionOrder[i]);
    if (!record) continue;
    const key = `${record.owner}/${record.repo}`;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(record);
  }

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const result = {};
  for (const [key, recs] of byRepo) {
    const days = new Array(SPARKLINE_DAYS).fill(0);
    for (const r of recs) {
      const ageDays = Math.floor((now - new Date(r.createdAt).getTime()) / dayMs);
      if (ageDays >= 0 && ageDays < SPARKLINE_DAYS) days[SPARKLINE_DAYS - 1 - ageDays] += 1;
    }

    const sample = recs.slice(0, STATS_SAMPLE).filter((r) => FINAL_STATUSES.has(r.status));
    const successCount = sample.filter((r) => r.status === "success").length;
    const successRate = sample.length ? Math.round((successCount / sample.length) * 100) : null;

    const durations = sample
      .filter((r) => r.status === "success" && r.finishedAt)
      .map((r) => new Date(r.finishedAt).getTime() - new Date(r.createdAt).getTime())
      .filter((ms) => ms >= 0);
    const avgDurationMs = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    result[key] = { days, successRate, avgDurationMs, sampleSize: sample.length };
  }
  return result;
}

function previousSha(record) {
  const idx = insertionOrder.indexOf(record.id);
  if (idx === -1) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const r = records.get(insertionOrder[i]);
    if (!r || r.owner !== record.owner || r.repo !== record.repo) continue;
    return r.sha !== record.sha ? r.sha : null;
  }
  return null;
}

module.exports = { create, update, get, list, latestByRepo, statsByRepo, previousSha, flush: persist.flush };
