// Mode "maintenance" par repo : un site marqué ici n'affiche plus ses
// échecs comme une alerte sur la page santé (badge neutre à la place),
// utile pendant un chantier volontaire pour éviter le bruit visuel. Ne
// touche à rien côté GitHub/Dokploy — purement cosmétique côté /deployments.
const path = require("path");
const { readJson, makeDebouncedWriter } = require("./json-file");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "muted-repos.json");

const muted = new Set(readJson(DATA_FILE, []));

const persist = makeDebouncedWriter("mute", DATA_DIR, DATA_FILE, () => [...muted]);

function toggle(key) {
  if (muted.has(key)) muted.delete(key);
  else muted.add(key);
  persist();
  return muted.has(key);
}

function list() {
  return [...muted];
}

module.exports = { toggle, list };
