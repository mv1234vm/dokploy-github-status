const crypto = require("crypto");

function makeSigner(secret) {
  function sign(payload, ttlSeconds) {
    const expires = Date.now() + ttlSeconds * 1000;
    const data = `${payload}.${expires}`;
    const sig = crypto.createHmac("sha256", secret).update(data).digest("hex");
    return Buffer.from(`${data}.${sig}`, "utf8").toString("base64url");
  }

  function verify(token, expectedPayload) {
    if (!token) return false;
    try {
      const decoded = Buffer.from(String(token), "base64url").toString("utf8");
      const firstDot = decoded.indexOf(".");
      const lastDot = decoded.lastIndexOf(".");
      if (firstDot === -1 || lastDot === firstDot) return false;
      const payload = decoded.slice(0, firstDot);
      const expiresStr = decoded.slice(firstDot + 1, lastDot);
      const sig = decoded.slice(lastDot + 1);
      if (payload !== expectedPayload) return false;
      const expires = Number(expiresStr);
      if (!Number.isFinite(expires) || Date.now() > expires) return false;
      const data = `${payload}.${expiresStr}`;
      const expectedSig = crypto.createHmac("sha256", secret).update(data).digest("hex");
      const a = Buffer.from(sig, "hex");
      const b = Buffer.from(expectedSig, "hex");
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  return { sign, verify };
}

module.exports = { makeSigner };
