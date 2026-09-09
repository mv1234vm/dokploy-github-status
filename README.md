# dokploy-github-status

Petit serveur Express qui reçoit la **notification Webhook de Dokploy** et met à jour
les statuts sur GitHub (**deployment statuses** + **commit statuses**), pour reproduire
le comportement de Vercel : une pastille verte/rouge sur chaque commit déployé.

Une seule config, puis c'est automatique pour **toutes** les apps Dokploy dont le nom
correspond au nom du repo GitHub.

## Variables d'environnement

| Variable         | Requis | Description                                                                    |
| ---------------- | ------ | ---------------------------------------------------------------------------- |
| `GITHUB_TOKEN`   | oui    | PAT fine-grained : **Contents=Read**, **Deployments=R/W**, **Commit statuses=R/W** |
| `WEBHOOK_SECRET` | oui    | Secret partagé (≥ 16 car.), envoyé par Dokploy dans le header `x-webhook-secret` |
| `GITHUB_OWNER`   | oui\*  | Ton compte/orga GitHub. Le repo est supposé porter le même nom que l'app Dokploy |
| `GITHUB_BRANCH`  | non    | Branche suivie (défaut `main`)                                               |
| `APP_MAP`        | non    | JSON d'exceptions : `{"nom-app":"owner/repo"}` ou `{"nom-app":"owner/repo@branche"}` |

\* `GITHUB_OWNER` ou `APP_MAP` : au moins un des deux.

## Mise en place (une fois)

### 1. Déployer ce service sur Dokploy
- Create Application → Git → ce repo → build **Dockerfile**
- Environment : renseigner les variables ci-dessus
- Domains : générer un domaine, port `3000`, HTTPS

### 2. Créer la notification Webhook Dokploy
Dokploy → **Notifications** → **Add** → **Webhook**
- URL : `https://<ton-domaine>/webhook`
- Custom headers :
  ```
  x-webhook-secret: <la valeur de WEBHOOK_SECRET>
  ```
- Événements : **App Deployed** + **Build failed**
- Create (la notification est globale : elle couvre toutes les apps)

### 3. C'est fini
À chaque déploiement Dokploy, le commit correspondant sur GitHub reçoit son statut.

## Comment ça marche

Dokploy n'envoie ni le repo ni le commit SHA. Le service :
1. déduit le repo : `APP_MAP[appName]` sinon `GITHUB_OWNER/appName`
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
- Refuse de démarrer sans `GITHUB_TOKEN`/`WEBHOOK_SECRET` (ou secret < 16 car.), ou sans `GITHUB_OWNER`/`APP_MAP`.
- `owner`/`repo`/`branch`/URL validés ; body JSON ≤ 16 kb ; timeout 10 s sur GitHub ; `x-powered-by` off.
- Les erreurs GitHub sont loggées côté serveur, jamais renvoyées au client (500 générique).
- `npm audit` : 0 vulnérabilité (Express 5, aucune autre dépendance).
- À exposer uniquement en HTTPS ; garder `WEBHOOK_SECRET` et `GITHUB_TOKEN` hors du dépôt.

## Développement local

```bash
npm install
GITHUB_TOKEN=xxx WEBHOOK_SECRET=0123456789abcdef GITHUB_OWNER=mv1234vm npm start
```
