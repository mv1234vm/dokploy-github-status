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
  schedule.flush = writeNow;
  return schedule;
}

module.exports = { readJson, makeDebouncedWriter };
