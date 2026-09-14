// Historique des déploiements suivis par ce service, indexé par l'identifiant
// numérique du "Deployment" GitHub (même id que /repos/:o/:r/deployments/:id).
//
// Persisté sur disque (JSON) pour survivre à un redémarrage du process dans
// le MÊME conteneur (crash, `npm start` relancé...). Ça ne survit PAS à un
// redéploiement (nouvelle image = nouveau conteneur = disque vierge) sauf si
// DATA_DIR pointe vers un volume Dokploy monté — voir le README. Sans
// volume, c'est le même compromis qu'avant (mémoire pure), en mieux : au
// moins les redémarrages "légers" ne perdent plus rien.
const fs = require("fs");
const path = require("path");

// Chaque fiche pèse ~0.5 à 1 Ko (quelques champs texte + un historique de
// 3-6 entrées). 300 fiches max = quelques centaines de Ko sur disque comme
// en mémoire, négligeable pour un petit service Node.
const MAX_RECORDS = 300;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "deployments.json");

const records = new Map(); // id (string) -> record
const insertionOrder = []; // ids dans l'ordre de création, pour purger les plus anciens

const FINAL_STATUSES = new Set(["success", "failure", "error"]);

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const record of parsed) {
      if (!record || typeof record.id !== "string") continue;
      records.set(record.id, record);
      insertionOrder.push(record.id);
    }
    console.log(`[store] ${records.size} déploiement(s) rechargé(s) depuis ${DATA_FILE}`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[store] lecture de ${DATA_FILE} impossible (${err.message}), on repart à vide`);
    }
  }
}

let saveScheduled = false;
function persist() {
  // Débounce léger : plusieurs create()/update() rapprochés (un cycle de
  // déploiement en pose 2-3 coup sur coup) ne déclenchent qu'une écriture.
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(() => {
    saveScheduled = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const data = insertionOrder.map((id) => records.get(id)).filter(Boolean);
      fs.writeFileSync(DATA_FILE, JSON.stringify(data), "utf8");
    } catch (err) {
      console.warn(`[store] écriture de ${DATA_FILE} impossible : ${err.message}`);
    }
  });
}

loadFromDisk();

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
    // Un déploiement peut arriver directement "success"/"failure" sans être
    // passé par "pending" côté service (rattrapage, webhook only sans
    // poller...) : sans ce cas, finishedAt restait à null pour toujours et
    // la durée affichée grossissait indéfiniment sur la page.
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

// Les plus récents d'abord — pour la page /deployments (liste + santé).
function list(limit = 100) {
  return insertionOrder
    .slice(-limit)
    .reverse()
    .map((id) => records.get(id))
    .filter(Boolean);
}

// Dernier déploiement connu par repo (owner/repo), pour un état de santé
// "un coup d'œil, tous mes sites".
function latestByRepo() {
  const map = new Map(); // "owner/repo" -> record le plus récent
  for (const id of insertionOrder) {
    const record = records.get(id);
    if (!record) continue;
    const key = `${record.owner}/${record.repo}`;
    const current = map.get(key);
    if (!current || record.updatedAt > current.updatedAt) map.set(key, record);
  }
  return [...map.values()].sort((a, b) => (a.repo > b.repo ? 1 : -1));
}

module.exports = { create, update, get, list, latestByRepo };
