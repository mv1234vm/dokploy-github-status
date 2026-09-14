// Jetons signés sans état côté serveur (pas de table de sessions à gérer) :
// - jeton de session (mot de passe correct) : payload fixe "session",
//   accepté pour n'importe quelle page /deployments/:id.
// - jeton de lien (posé dans l'URL renvoyée à GitHub) : payload
//   "deployment:<id>", n'autorise QUE ce déploiement précis. Un lien copié/
//   partagé ne donne donc jamais accès aux autres déploiements.
// Les deux sont signés par HMAC-SHA256 avec WEBHOOK_SECRET (déjà un secret
// exigé au démarrage du service) : inutile d'ajouter une variable d'env.
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
