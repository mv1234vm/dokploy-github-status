const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// store.js lit DATA_DIR une seule fois au chargement du module (singleton) :
// on pointe vers un dossier temporaire dédié AVANT le require, pour ne
// jamais toucher aux vraies données ni à data/ du dépôt.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dgs-store-test-"));
process.env.DATA_DIR = tmpDir;
const store = require("../store");

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("create() stores a record retrievable by get()", () => {
  const record = store.create("1001", {
    owner: "acme",
    repo: "site",
    sha: "abc123",
    branch: "main",
    status: "pending",
    description: "En cours",
  });
  assert.equal(record.id, "1001");
  assert.equal(store.get("1001").status, "pending");
});

test("create() sets finishedAt only for a record created already in a final state", () => {
  const pending = store.create("1002", { owner: "acme", repo: "a", sha: "s1", status: "pending", description: "..." });
  assert.equal(pending.finishedAt, null);

  const success = store.create("1003", { owner: "acme", repo: "b", sha: "s2", status: "success", description: "..." });
  assert.notEqual(success.finishedAt, null);
});

test("update() moves a pending record to a final state and sets finishedAt", () => {
  store.create("1004", { owner: "acme", repo: "c", sha: "s3", status: "pending", description: "..." });
  const updated = store.update("1004", "success", "Déployé avec succès");
  assert.equal(updated.status, "success");
  assert.notEqual(updated.finishedAt, null);
  assert.equal(updated.history.length, 2);
});

test("update() on an unknown id returns null instead of throwing", () => {
  assert.equal(store.update("does-not-exist", "success", "x"), null);
});

test("list() paginates and filters by status and search", () => {
  store.create("2001", { owner: "x", repo: "filter-test", sha: "s", status: "success", description: "ok" });
  store.create("2002", { owner: "x", repo: "filter-test", sha: "s", status: "failure", description: "ko" });
  store.create("2003", { owner: "x", repo: "other-repo", sha: "s", status: "success", description: "ok" });

  const byStatus = store.list(100, 0, { status: "failure" });
  assert.ok(byStatus.items.every((r) => r.status === "failure"));
  assert.ok(byStatus.items.some((r) => r.id === "2002"));

  const bySearch = store.list(100, 0, { search: "filter-test" });
  assert.ok(bySearch.items.every((r) => r.repo === "filter-test"));

  const page = store.list(1, 0, {});
  assert.equal(page.items.length, 1);
});

test("latestByRepo() returns only the most recently updated record per repo", () => {
  store.create("3001", { owner: "y", repo: "latest-test", sha: "s1", status: "pending", description: "..." });
  store.update("3001", "success", "done");
  store.create("3002", { owner: "y", repo: "latest-test", sha: "s2", status: "pending", description: "..." });

  const health = store.latestByRepo().filter((r) => r.repo === "latest-test");
  assert.equal(health.length, 1);
  assert.equal(health[0].id, "3002");
});

test("previousSha() finds the prior deployment for the same repo, skipping identical shas", () => {
  store.create("4001", { owner: "z", repo: "compare-test", sha: "sha-a", status: "success", description: "..." });
  const second = store.create("4002", { owner: "z", repo: "compare-test", sha: "sha-b", status: "success", description: "..." });
  assert.equal(store.previousSha(second), "sha-a");

  const first = store.get("4001");
  assert.equal(store.previousSha(first), null);
});

test("statsByRepo() computes a success rate and an average duration from final records", () => {
  store.create("5001", { owner: "w", repo: "stats-test", sha: "s1", status: "success", description: "..." });
  store.create("5002", { owner: "w", repo: "stats-test", sha: "s2", status: "failure", description: "..." });

  const stats = store.statsByRepo()["w/stats-test"];
  assert.ok(stats);
  assert.equal(stats.successRate, 50);
  assert.equal(stats.days.length, 14);
});
