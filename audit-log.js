// Journal d'audit minimal : qui/quand pour les connexions et les relances.
// Même principe de persistance que store.js (JSON, debounce), mais fichier
// séparé et plus petit — ce n'est pas l'historique fonctionnel du bot, juste
// une trace pour "qui a fait quoi" quand le mot de passe est partagé.
const path = require("path");
const { readJson, makeDebouncedWriter } = require("./json-file");

const MAX_ENTRIES = 200;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "audit-log.json");

let entries = readJson(DATA_FILE, []).slice(-MAX_ENTRIES);

const persist = makeDebouncedWriter("audit", DATA_DIR, DATA_FILE, () => entries);

// type: "login_success" | "login_failure" | "retry" | "password_change"
function record(type, details = {}) {
  entries.push({ type, at: new Date().toISOString(), ...details });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  persist();
}

// filters.type / filters.ip / filters.since (ISO date, inclus) s'appliquent
// avant la limite, pour que "les 50 derniers échecs de connexion" ait un sens.
function list(limit = 100, filters = {}) {
  let all = entries.slice().reverse();
  if (filters.type) all = all.filter((e) => e.type === filters.type);
  if (filters.ip) all = all.filter((e) => e.ip === filters.ip);
  if (filters.since) all = all.filter((e) => e.at >= filters.since);
  return all.slice(0, limit);
}

module.exports = { record, list, flush: persist.flush };
