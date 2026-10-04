const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeSigner } = require("../auth");

test("sign/verify roundtrip with correct payload succeeds", () => {
  const signer = makeSigner("test-secret-0123456789");
  const token = signer.sign("session", 60);
  assert.equal(signer.verify(token, "session"), true);
});

test("verify fails for a different payload (link token not reusable for another id)", () => {
  const signer = makeSigner("test-secret-0123456789");
  const token = signer.sign("deployment:123", 60);
  assert.equal(signer.verify(token, "deployment:456"), false);
  assert.equal(signer.verify(token, "session"), false);
});

test("verify fails once the token has expired", () => {
  const signer = makeSigner("test-secret-0123456789");
  const token = signer.sign("session", -1); // déjà expiré
  assert.equal(signer.verify(token, "session"), false);
});

test("verify fails for a token signed with a different secret", () => {
  const signerA = makeSigner("secret-a-0123456789");
  const signerB = makeSigner("secret-b-0123456789");
  const token = signerA.sign("session", 60);
  assert.equal(signerB.verify(token, "session"), false);
});

test("verify rejects garbage input without throwing", () => {
  const signer = makeSigner("test-secret-0123456789");
  assert.equal(signer.verify("", "session"), false);
  assert.equal(signer.verify(undefined, "session"), false);
  assert.equal(signer.verify("not-a-valid-token", "session"), false);
  assert.equal(signer.verify("%%%invalid-base64url%%%", "session"), false);
});

test("a tampered signature is rejected", () => {
  const signer = makeSigner("test-secret-0123456789");
  const token = signer.sign("session", 60);
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const tampered = decoded.slice(0, -1) + (decoded.slice(-1) === "a" ? "b" : "a");
  const tamperedToken = Buffer.from(tampered, "utf8").toString("base64url");
  assert.equal(signer.verify(tamperedToken, "session"), false);
});
