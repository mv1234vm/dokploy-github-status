// Mode "maintenance" par repo : un site marqué ici n'affiche plus ses
// échecs comme une alerte sur la page santé (badge neutre à la place),
// utile pendant un chantier volontaire pour éviter le bruit visuel. Ne
// touche à rien côté GitHub/Dokploy — purement cosmétique côté /deployments.
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "muted-repos.json");

let muted = new Set();

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) muted = new Set(parsed);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[mute] lecture de ${DATA_FILE} impossible (${err.message}), on repart à vide`);
    }
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...muted]), "utf8");
  } catch (err) {
    console.warn(`[mute] écriture de ${DATA_FILE} impossible : ${err.message}`);
  }
}

loadFromDisk();

function isMuted(key) {
  return muted.has(key);
}

function toggle(key) {
  if (muted.has(key)) muted.delete(key);
  else muted.add(key);
  persist();
  return muted.has(key);
}

function list() {
  return [...muted];
}

module.exports = { isMuted, toggle, list };
