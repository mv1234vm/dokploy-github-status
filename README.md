# dokploy-github-status

Petit serveur Express qui reçoit la **notification Webhook de Dokploy** et met à jour
les statuts sur GitHub (**deployment statuses** + **commit statuses**), pour reproduire
le comportement de Vercel : une pastille verte/rouge sur chaque commit déployé.

Une seule config, puis c'est automatique pour **toutes** les apps Dokploy dont le nom
correspond au nom du repo GitHub.

## Variables d'environnement

| Variable          | Requis | Description                                                                    |
| ----------------- | ------ | ---------------------------------------------------------------------------- |
| `GITHUB_TOKEN`    | oui    | PAT fine-grained : **Contents=Read**, **Deployments=R/W**, **Commit statuses=R/W** |
| `WEBHOOK_SECRET`  | oui    | Secret partagé (≥ 16 car.), envoyé par Dokploy dans le header `x-webhook-secret` |
| `DOKPLOY_API_KEY` | oui\*  | Clé API Dokploy (Settings → API/Swagger). Le service retrouve seul le repo de chaque app. |
| `DOKPLOY_URL`     | non    | URL Dokploy si la déduction auto échoue                                      |
| `GITHUB_BRANCH`   | non    | Branche par défaut (défaut `main`)                                           |
| `GITHUB_OWNER`    | non    | Fallback si pas d'API Dokploy : `owner`, repo = nom de l'app                 |
| `APP_MAP`         | non    | Fallback : `{"nom-app":"owner/repo"}` ou `{"nom-app":"owner/repo@branche"}`  |

\* `DOKPLOY_API_KEY` **ou** `GITHUB_OWNER`/`APP_MAP`.

## Mise en place (une fois, ~3 min)

### 1. Déployer ce service sur Dokploy
- Create Application → Git → ce repo → build **Dockerfile**
- Environment : `GITHUB_TOKEN`, `WEBHOOK_SECRET`, `DOKPLOY_API_KEY`
- Domains : générer un domaine, port `3000`, HTTPS

### 2. Générer la clé API Dokploy
Dokploy → **Settings → API/Swagger** → *Generate API Key* → colle-la dans `DOKPLOY_API_KEY`.

### 3. Créer la notification Webhook Dokploy
Dokploy → **Notifications** → **Add** → **Webhook**
- URL : `https://<ton-domaine>/webhook`
- Custom headers :
  ```
  x-webhook-secret: <la valeur de WEBHOOK_SECRET>
  ```
- Événements : **App Deployed** + **Build failed**
- Create (globale : couvre toutes les apps, présentes et futures)

### 4. C'est fini
Aucune config par app. À chaque déploiement, le bon commit GitHub reçoit son statut.

## Comment ça marche

Dokploy n'envoie ni le repo ni le SHA, mais la notification contient un lien vers l'app.
Le service :
1. extrait l'`applicationId` du lien, interroge l'API Dokploy → `owner`/`repo`/`branch`
   (fallback : `APP_MAP` puis `GITHUB_OWNER/appName`)
2. récupère le dernier commit de la branche via l'API GitHub
3. pose un deployment status + un commit status (`context: "Dokploy"`)

Limite : pas de statut « en cours » (Dokploy ne notifie qu'à la fin du déploiement).

## Format manuel (optionnel)

Le endpoint accepte aussi un appel explicite, utile pour tester ou scripter :

```bash
curl -X POST https://<ton-domaine>/webhook \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{
    "appName": "mon-app",
    "status": "done",
    "sha": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    "githubOwner": "mv1234vm",
    "githubRepo": "mon-repo",
    "appUrl": "https://mon-app.exemple.fr"
  }'
```

`status` : `running`/`pending` → pending, `done`/`success` → success,
`failed`/`failure` → failure, `error` → error.

## Sécurité

- Header `x-webhook-secret` comparé en temps constant (`crypto.timingSafeEqual`).
- Refuse de démarrer sans `GITHUB_TOKEN`/`WEBHOOK_SECRET` (ou secret < 16 car.), ou sans `DOKPLOY_API_KEY`/`GITHUB_OWNER`/`APP_MAP`.
- `owner`/`repo`/`branch`/URL validés ; body JSON ≤ 16 kb ; timeout 10 s sur GitHub ; `x-powered-by` off.
- Les erreurs GitHub sont loggées côté serveur, jamais renvoyées au client (500 générique).
- `npm audit` : 0 vulnérabilité (Express 5, aucune autre dépendance).
- À exposer uniquement en HTTPS ; garder `WEBHOOK_SECRET` et `GITHUB_TOKEN` hors du dépôt.

## Développement local

```bash
npm install
GITHUB_TOKEN=xxx WEBHOOK_SECRET=0123456789abcdef GITHUB_OWNER=mv1234vm npm start
```
