const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readJson, makeDebouncedWriter } = require("../json-file");

test("readJson returns the fallback when the file does not exist (ENOENT)", () => {
  const missing = path.join(os.tmpdir(), "dgs-json-file-test-missing.json");
  assert.deepEqual(readJson(missing, { ok: true }), { ok: true });
});

test("readJson returns the fallback on invalid JSON instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dgs-json-file-test-"));
  const file = path.join(dir, "corrupt.json");
  fs.writeFileSync(file, "{ not valid json", "utf8");
  assert.deepEqual(readJson(file, []), []);
});

test("readJson round-trips what a prior write produced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dgs-json-file-test-"));
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, JSON.stringify([{ a: 1 }, { a: 2 }]), "utf8");
  assert.deepEqual(readJson(file, []), [{ a: 1 }, { a: 2 }]);
});

test("the debounced writer only touches disk once for several synchronous calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dgs-json-file-test-"));
  const file = path.join(dir, "data.json");
  let writeCount = 0;
  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (...args) => {
    writeCount += 1;
    return realWriteFileSync(...args);
  };
  try {
    let value = "a";
    const schedule = makeDebouncedWriter("test", dir, file, () => value);
    schedule();
    value = "b";
    schedule();
    value = "c";
    schedule();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writeCount, 1);
    assert.equal(readJson(file, null), "c"); // la dernière valeur l'emporte, pas la première
  } finally {
    fs.writeFileSync = realWriteFileSync;
  }
});

test("flush() writes synchronously without waiting for the event loop", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dgs-json-file-test-"));
  const file = path.join(dir, "data.json");
  const schedule = makeDebouncedWriter("test", dir, file, () => ({ flushed: true }));
  schedule.flush();
  assert.deepEqual(readJson(file, null), { flushed: true });
});

test("a write failure (e.g. unwritable directory) is caught, not thrown", () => {
  // Un fichier comme "dossier" force mkdirSync/writeFileSync à échouer.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dgs-json-file-test-"));
  const blocker = path.join(dir, "blocked");
  fs.writeFileSync(blocker, "x");
  const file = path.join(blocker, "data.json"); // "blocked" n'est pas un dossier
  const schedule = makeDebouncedWriter("test", blocker, file, () => ({ a: 1 }));
  assert.doesNotThrow(() => schedule.flush());
});
