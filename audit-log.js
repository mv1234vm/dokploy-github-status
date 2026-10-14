const path = require("path");
const { readJson, makeDebouncedWriter } = require("./json-file");

const MAX_ENTRIES = 200;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "audit-log.json");

let entries = readJson(DATA_FILE, []).slice(-MAX_ENTRIES);

const persist = makeDebouncedWriter("audit", DATA_DIR, DATA_FILE, () => entries);

function record(type, details = {}) {
  entries.push({ type, at: new Date().toISOString(), ...details });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  persist();
}

function list(limit = 100, filters = {}) {
  let all = entries.slice().reverse();
  if (filters.type) all = all.filter((e) => e.type === filters.type);
  if (filters.ip) all = all.filter((e) => e.ip === filters.ip);
  if (filters.since) all = all.filter((e) => e.at >= filters.since);
  return all.slice(0, limit);
}

module.exports = { record, list, flush: persist.flush };
