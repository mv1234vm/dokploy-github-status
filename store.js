// Historique des déploiements suivis par ce service, indexé par l'identifiant
// numérique du "Deployment" GitHub (même id que /repos/:o/:r/deployments/:id).
// En mémoire uniquement : pas de volume persistant configuré pour ce service,
// donc un redémarrage repart de zéro. Un déploiement créé avant redémarrage
// affichera un 404 propre sur sa page /deployments/:id plutôt que des
// données inventées — c'est le compromis assumé plutôt que d'ajouter une
// dépendance base de données pour ce besoin.
// Chaque fiche pèse ~0.5 à 1 Ko (quelques champs texte + un historique de
// 3-6 entrées). 200 fiches max = quelques centaines de Ko en mémoire dans le
// pire cas, négligeable pour un petit service Node.
const MAX_RECORDS = 200;

const records = new Map(); // id (string) -> record
const insertionOrder = []; // ids dans l'ordre de création, pour purger les plus anciens

const FINAL_STATUSES = new Set(["success", "failure", "error"]);

function create(id, fields) {
  const now = new Date().toISOString();
  const record = {
    id,
    owner: fields.owner,
    repo: fields.repo,
    sha: fields.sha,
    branch: fields.branch || null,
    appName: fields.appName || null,
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
  return record;
}

function get(id) {
  return records.get(id) || null;
}

module.exports = { create, update, get };
