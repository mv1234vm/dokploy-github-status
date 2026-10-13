// Lecture/écriture JSON partagée par store.js, audit-log.js et mute.js :
// mêmes fichiers plats dans DATA_DIR, même tolérance à un fichier absent,
// même débounce d'écriture (plusieurs changements rapprochés ne déclenchent
// qu'une seule écriture disque, via setImmediate).
const fs = require("fs");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[json-file] lecture de ${file} impossible (${err.message}), on repart à vide`);
    }
    return fallback;
  }
}

function makeDebouncedWriter(label, dir, file, getData) {
  let scheduled = false;

  function writeNow() {
    scheduled = false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(getData()), "utf8");
    } catch (err) {
      console.warn(`[${label}] écriture de ${file} impossible : ${err.message}`);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(writeNow);
  }
  // Écriture synchrone immédiate : à utiliser sur SIGTERM/SIGINT pour ne pas
  // perdre le dernier changement resté dans la fenêtre de debounce quand le
  // conteneur s'arrête (ça nous est déjà arrivé en pratique).
  schedule.flush = writeNow;
  return schedule;
}

module.exports = { readJson, makeDebouncedWriter };
