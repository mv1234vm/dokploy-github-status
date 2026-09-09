# dokploy-github-status

Petit serveur Express qui reçoit des webhooks Dokploy et met à jour les statuts de
déploiement sur GitHub (**deployment statuses** + **commit statuses**), pour
reproduire le comportement de Vercel avec Dokploy.

## Variables d'environnement

| Variable         | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| `GITHUB_TOKEN`   | Token GitHub (PAT ou GitHub App) avec les scopes `repo` / `deployments`.   |
| `WEBHOOK_SECRET` | Secret partagé, comparé au header `x-webhook-secret` de chaque requête.     |

Copier `.env.example` vers `.env` et remplir les valeurs.

## Déploiement sur Dokploy

1. Créer une nouvelle application **Docker** (ou via ce repo Git).
2. Dokploy détecte le `Dockerfile` à la racine — aucune configuration de build nécessaire.
3. Dans **Environment**, définir `GITHUB_TOKEN` et `WEBHOOK_SECRET`.
4. Exposer le port `3000` et associer un domaine (ex. `deploy-status.mondomaine.fr`).
5. Déployer. L'endpoint public devient : `https://deploy-status.mondomaine.fr/webhook`.
6. Configurer les autres applications Dokploy pour appeler ce webhook en fin de
   déploiement (webhook sortant / notification), avec le header
   `x-webhook-secret: <WEBHOOK_SECRET>`.

## Format du body webhook attendu

```json
{
  "appName": "mon-app",
  "status": "running | done | failed | error",
  "sha": "commit-sha-complet",
  "githubOwner": "mon-org",
  "githubRepo": "mon-repo",
  "appUrl": "https://mon-app.mondomaine.fr"
}
```

Mapping des statuts :

| `status` Dokploy | `state` GitHub | Description                 |
| ---------------- | -------------- | -------------------------- |
| `running`        | `pending`      | Déploiement en cours...     |
| `done`           | `success`      | Déployé avec succès ✅       |
| `failed`         | `failure`      | Échec du déploiement ❌      |
| `error`          | `error`        | Erreur ❌                    |

## Exemple curl de test

```bash
curl -X POST https://deploy-status.mondomaine.fr/webhook \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{
    "appName": "mon-app",
    "status": "done",
    "sha": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    "githubOwner": "mon-org",
    "githubRepo": "mon-repo",
    "appUrl": "https://mon-app.mondomaine.fr"
  }'
```

## Sécurité

- Header `x-webhook-secret` comparé en **temps constant** (`crypto.timingSafeEqual`).
- Refus de démarrer si `GITHUB_TOKEN`/`WEBHOOK_SECRET` absents ou secret < 16 caractères.
- `githubOwner`, `githubRepo`, `sha` validés par regex (pas d'injection de path / d'URL).
- `appUrl` accepté seulement si c'est une URL `http(s)` valide.
- Body JSON limité à 16 kb ; timeout de 10 s sur les appels GitHub ; `x-powered-by` désactivé.
- Les erreurs GitHub sont loggées côté serveur mais **jamais renvoyées** au client (réponse 500 générique).
- `0 vulnerabilities` (`npm audit`) — Express 5, aucune autre dépendance.
- À faire côté infra : exposer le service **uniquement en HTTPS** (domaine Dokploy) et
  garder le `WEBHOOK_SECRET` hors du dépôt.

## Développement local

```bash
npm install
GITHUB_TOKEN=xxx WEBHOOK_SECRET=yyy npm start
```
