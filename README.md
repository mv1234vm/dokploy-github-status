# dokploy-github-status

Petit service Express, sans base de données, qui relie **Dokploy** et
**GitHub** : à chaque déploiement, il pose sur le commit correspondant la
pastille ✅/🔵/❌ que GitHub affiche nativement pour Vercel/Netlify, avec en
plus une **page de détail dédiée** pour chaque déploiement.

Zéro dépendance en dehors d'Express, zéro configuration par app une fois le
service en place — il découvre lui-même le repo GitHub de chaque application
Dokploy.

```
   git push
      │
      ▼                     "je déploie" / "c'est fini"
┌──────────┐   déploie   ┌──────────────────┐   webhook / poll   ┌────────────────────────┐
│  GitHub  │ ──────────► │      Dokploy     │ ──────────────────►│ dokploy-github-status  │
└──────────┘             └──────────────────┘                    │  (ce service)          │
      ▲                                                          └───────────┬────────────┘
      │ pose la pastille + un lien "Details"                                 │
      └───────────────────────────────────────────────────────────────────────┘
                              GET /deployments/:id  ← ce que "Details" ouvre
```

---

## Sommaire

- [Ce que fait le service](#ce-que-fait-le-service)
- [Mise en place (checklist)](#mise-en-place-checklist)
- [Variables d'environnement](#variables-denvironnement)
- [Routes](#routes)
- [Comment ça marche en détail](#comment-ça-marche-en-détail)
- [Statut « en cours »](#statut--en-cours-)
- [Pages de déploiement `/deployments/:id`](#pages-de-déploiement-deploymentsid)
- [Persistance](#persistance)
- [Liste + état de santé de tous les sites](#liste--état-de-santé-de-tous-les-sites-deployments)
- [Fiabilité (pending bloqués, statuts manquants)](#fiabilité-pending-bloqués-statuts-manquants)
- [Sécurité](#sécurité)
- [Format manuel / test](#format-manuel--test)
- [Structure du projet](#structure-du-projet)
- [Développement local](#développement-local)
- [Dépannage](#dépannage)

---

## Ce que fait le service

1. **Détecte** qu'une app Dokploy commence, réussit ou échoue un déploiement
   (webhook Dokploy + sondage périodique de l'API Dokploy, en filet de
   sécurité).
2. **Retrouve** tout seul à quel repo/branche/commit GitHub ça correspond.
3. **Pose le statut** sur GitHub :
   - un **commit status** (`context: "Dokploy"`) → la pastille à côté du
     commit et dans les checks d'une PR ;
   - un vrai **GitHub Deployment** → visible dans l'onglet *Environments*/
     *Deployments* du repo.
4. Le lien **Details** de ce statut ouvre une **page dédiée** générée par ce
   service (`/deployments/:id`), pas juste les logs bruts de Dokploy.

Tout ça sans jamais exposer le token GitHub, la clé API Dokploy ou un mot de
passe au navigateur.

## Mise en place (checklist)

### 1. Déployer ce service sur Dokploy
- **Create Application** → Git → ce repo → build **Dockerfile**
- **Domains** : générer un domaine, port `3000`, HTTPS activé

### 2. Générer le token GitHub
Fine-grained PAT avec, sur les repos concernés : **Contents = Read**,
**Deployments = Read/Write**, **Commit statuses = Read/Write**.

### 3. Générer la clé API Dokploy
Dokploy → **Settings → Profile** → section *API/CLI* → *Generate* (laisse le
rate limiting vide) → copie la clé immédiatement, elle ne se réaffiche pas.

### 4. Renseigner l'Environment du service
```
GITHUB_TOKEN=github_pat_xxx
WEBHOOK_SECRET=<openssl rand -hex 24>
DOKPLOY_API_KEY=<clé de l'étape 3>
DOKPLOY_URL=https://ton-dokploy
PUBLIC_URL=https://<domaine de ce service>
DASHBOARD_PASSWORD=<openssl rand -hex 16>
```
→ **Redeploy**.

### 5. Créer la notification Webhook Dokploy (une seule fois, globale)
Dokploy → **Notifications** → **Add** → **Webhook**
- URL : `https://<ton-domaine>/webhook`
- Header : `x-webhook-secret: <WEBHOOK_SECRET>`
- Événements : **App Deployed** + **Build failed**
- **Create**

### 6. C'est fini
Aucune configuration par app. Déploie n'importe quelle app Dokploy → le bon
commit GitHub reçoit sa pastille, cliquable vers sa page de détail.

## Variables d'environnement

| Variable | Requis | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | **oui** | PAT fine-grained : Contents=Read, Deployments=R/W, Commit statuses=R/W |
| `WEBHOOK_SECRET` | **oui** | Secret partagé (≥ 16 car.), attendu dans le header `x-webhook-secret` de la notification Dokploy. Sert aussi de clé pour signer les jetons des pages `/deployments/:id`. |
| `DOKPLOY_API_KEY` | oui\* | Clé API Dokploy — permet de retrouver seul le repo GitHub de chaque app |
| `DOKPLOY_URL` | non | URL du Dokploy, ex. `https://vps.exemple.fr` — sinon déduite automatiquement de la 1ʳᵉ notification reçue |
| `GITHUB_BRANCH` | non | Branche par défaut si Dokploy n'en précise pas (défaut `main`) |
| `GITHUB_OWNER` | non | Fallback si pas d'`DOKPLOY_API_KEY` : compte GitHub, repo = nom de l'app Dokploy |
| `APP_MAP` | non | Fallback JSON pour les exceptions : `{"nom-app":"owner/repo"}` ou `{"nom-app":"owner/repo@branche"}` |
| `GITHUB_WEBHOOK_SECRET` | non | Active `POST /github` (webhook push GitHub) pour un statut « en cours » instantané, en plus du sondage automatique |
| `POLL` | non | `off` pour désactiver le sondage périodique de Dokploy (défaut `on`) |
| `POLL_INTERVAL_MS` | non | Fréquence du sondage, en ms (défaut `5000`, plancher `2000`) |
| `CATCHUP_MAX_AGE_MS` | non | Le rattrapage de statuts manqués ne concerne que les déploiements finis il y a moins de X ms (défaut 15 min, plancher 1 min) — évite de reposter tout l'historique récent au redémarrage du service |
| `PUBLIC_URL` | non | URL publique de **ce service**, sans `/` final — active les pages `/deployments/:id` |
| `DASHBOARD_PASSWORD` | non | Mot de passe pour ouvrir une page `/deployments/:id` en dehors d'un clic GitHub, et pour tout ce qui est derrière `/deployments` (liste, santé, relance) |
| `DATA_DIR` | non | Dossier où persister `deployments.json` (défaut `./data`) — voir [Persistance](#persistance) |

\* Il faut `DOKPLOY_API_KEY` **ou** `GITHUB_OWNER`/`APP_MAP` (au moins un des
deux).

## Routes

| Route | Rôle |
| --- | --- |
| `POST /webhook` | Notification Dokploy (fin de déploiement) |
| `POST /github` | Webhook GitHub *push* optionnel, pour le statut « en cours » instantané |
| `GET /deployments/:id` | Page de détail d'un déploiement (HTML) |
| `GET /api/deployments/:id` | Données JSON d'un déploiement, protégées par jeton (lien ou session) |
| `GET /deployments` | Liste + état de santé de tous les sites (HTML, **mot de passe requis**) |
| `GET /api/deployments` | Liste + santé en JSON, **jeton de session uniquement** (un jeton de lien ne fonctionne pas ici) |
| `POST /api/deployments/:id/retry` | Relance le déploiement via l'API Dokploy, **jeton de session uniquement** |
| `POST /api/login` | Échange un mot de passe contre un jeton de session |
| `GET /health` | Vérification de disponibilité + état du sondage Dokploy |
| `GET /` | Page d'accueil du service |

## Comment ça marche en détail

Dokploy n'envoie ni le repo GitHub ni le SHA dans sa notification — seulement
le nom de l'app et un lien vers son tableau de bord. Le service :

1. extrait l'`applicationId` de ce lien et interroge l'API Dokploy pour
   obtenir `owner`/`repo`/`branch` (avec repli sur `APP_MAP` puis
   `GITHUB_OWNER` + nom de l'app) ;
2. récupère le dernier commit de la branche via l'API GitHub (ou le commit
   exact enregistré par Dokploy, quand disponible, pour un rattrapage a
   posteriori) ;
3. crée un **GitHub Deployment**, enregistre une fiche locale sous son id,
   puis pose le **deployment status** et le **commit status**
   (`context: "Dokploy"`), avec `target_url`/`log_url` pointant vers
   `/deployments/<id>`.

## Statut « en cours »

Dokploy ne notifie **qu'à la fin** d'un déploiement — sans rien de plus, la
pastille passerait directement de rien à ✅/❌. Deux mécanismes, cumulables :

### Sondage automatique (actif par défaut)
Le service interroge l'API Dokploy toutes les `POLL_INTERVAL_MS` (5 s par
défaut). Dès qu'un déploiement passe à `running`, il pose le statut
`pending`/`in_progress` sur le commit correspondant. Aucune configuration par
repo. Désactiver : `POLL=off`.

### Webhook GitHub push (optionnel, plus instantané)
1. Génère un secret, mets-le dans `GITHUB_WEBHOOK_SECRET` → Redeploy.
2. GitHub → repo ou organisation → **Settings → Webhooks → Add webhook** :
   - Payload URL : `https://<ton-domaine>/github`
   - Content type : `application/json`
   - Secret : le même
   - Events : *Just the push event*

## Pages de déploiement `/deployments/:id`

Chaque déploiement a sa propre page, à l'identifiant GitHub réel (le même
`id` que `/repos/:owner/:repo/deployments/:id`) — jamais une page générique
qui mélangerait plusieurs déploiements.

**Contenu de la page** : statut coloré (🔵 en cours / 🟢 réussi / 🔴 échoué),
projet, branche, commit, environnement, dates de lancement/fin, durée,
timeline des changements d'état, liens vers GitHub/le commit/le site
déployé/les logs Dokploy. Rafraîchissement automatique toutes les 5 s tant
que le déploiement est en cours, arrêté dès qu'il se termine.

**Accès depuis GitHub — sans mot de passe.** Le lien *Details* posé sur
GitHub est de la forme `https://<PUBLIC_URL>/deployments/<id>?t=<jeton>`. Ce
jeton est signé (HMAC-SHA256, valable 90 jours) et **scopé à ce seul
déploiement** : il ouvre directement la page correspondante, mais un jeton
volé ou partagé ne donne accès à aucun autre déploiement — vérifié
explicitement côté serveur à chaque requête.

**Accès direct — avec mot de passe.** Ouvrir `/deployments/123` sans ce
jeton (URL copiée, favori, etc.) affiche un écran de mot de passe
(`DASHBOARD_PASSWORD`, 5 tentatives/minute/IP). Une fois validé, un jeton de
**session** (30 jours, distinct du jeton de lien, donnant accès à *tous* les
déploiements) est stocké dans `localStorage` — jamais le mot de passe
lui-même. Bouton **Se déconnecter** pour l'effacer et revenir à l'écran de
mot de passe au prochain accès direct.

**Ce que le navigateur ne reçoit jamais** : `GITHUB_TOKEN`, `DOKPLOY_API_KEY`,
`DASHBOARD_PASSWORD`, ni les données d'un autre déploiement que celui
demandé et autorisé.

Sans `PUBLIC_URL` configuré, cette fonctionnalité est simplement inactive et
les liens *Details* pointent vers les logs Dokploy comme avant.

## Persistance

L'historique (300 déploiements les plus récents, quelques centaines de Ko)
est sauvegardé dans `DATA_DIR/deployments.json` (défaut : `./data`), rechargé
au démarrage. Ça survit à un **redémarrage du process** dans le même
conteneur (crash, `npm start` relancé). Ça ne survit **pas** à un
**redéploiement** (nouvelle image = nouveau conteneur = disque vierge), sauf
si `DATA_DIR` pointe vers un **volume Dokploy monté** — sinon, redéployer ce
service lui-même repart de zéro comme avant (les anciennes pages `/deployments/:id`
renvoient alors un 404 propre plutôt que d'inventer des données).

## Liste + état de santé de tous les sites (`/deployments`)

Une page `/deployments` liste les derniers déploiements suivis et l'état de
santé courant de chaque repo (dernier statut connu). **Toujours** protégée
par `DASHBOARD_PASSWORD` — contrairement à `/deployments/:id`, un jeton de
lien posé sur GitHub (scopé à un seul déploiement) ne donne **jamais** accès
ici, seul le mot de passe (jeton de session) le permet. Si
`DASHBOARD_PASSWORD` n'est pas configuré, ces routes renvoient 503.

### Relancer un déploiement échoué

Sur la page d'un déploiement en échec, un bouton **Relancer** (visible
uniquement si connecté par mot de passe, jamais via un simple lien GitHub)
déclenche un nouveau déploiement via l'API Dokploy
(`POST /api/application.deploy`) pour l'`applicationId` concerné. Fonctionne
uniquement pour les déploiements créés après cette mise à jour (c'est là que
`applicationId` a commencé à être enregistré) ; sinon message d'erreur
explicite plutôt qu'un bouton qui ne fait rien.

## Fiabilité (pending bloqués, statuts manquants)

- **Pending qui ne se referme jamais** : si un commit B est poussé pendant
  que le déploiement de A tourne encore, Dokploy ne construit que B — A
  resterait bloqué en 🔵 pour toujours. Le service mémorise le dernier commit
  mis en `pending` par repo et referme automatiquement l'ancien
  (`state: success`, *« Remplacé par un déploiement plus récent »*) dès
  qu'un nouveau lui succède.
- **Statuts jamais posés** (webhook manqué) : les appels à l'API GitHub sont
  réessayés (2 tentatives, backoff) sur erreur réseau/5xx. En complément, le
  sondage périodique sert de filet de rattrapage : un déploiement vu passer
  directement à `done`/`error` sans jamais être passé par `running` via ce
  service se voit poser son statut final a posteriori (idempotent, pas de
  doublon si le webhook a bien fonctionné).

## Sécurité

- `x-webhook-secret` et signature `x-hub-signature-256` comparés en temps
  constant (`crypto.timingSafeEqual`).
- Mot de passe (`DASHBOARD_PASSWORD`) jamais renvoyé au client, jamais
  stocké en clair côté navigateur ; comparaison en temps constant ;
  throttle anti brute-force (5 tentatives/minute/IP).
- `/api/deployments/:id` vérifie l'authentification **avant** de regarder si
  l'id existe : impossible d'énumérer les ids valides sans être authentifié.
- Jetons de lien scopés à un seul `id`, jetons de session distincts —
  jamais interchangeables.
- Le service refuse de démarrer sans `GITHUB_TOKEN`/`WEBHOOK_SECRET` (ou
  secret < 16 caractères), ou sans un moyen de résoudre les repos
  (`DOKPLOY_API_KEY`/`GITHUB_OWNER`/`APP_MAP`).
- `owner`/`repo`/`branch`/URL/identifiants de déploiement validés par regex ;
  corps JSON ≤ 1 Mo ; timeout 10 s sur tous les appels sortants ;
  `x-powered-by` désactivé.
- Les erreurs GitHub/Dokploy sont loggées côté serveur uniquement, jamais
  renvoyées au client (réponses génériques).
- `npm audit` : 0 vulnérabilité (Express 5, aucune autre dépendance).
- À exposer uniquement en HTTPS ; garder tous les secrets hors du dépôt
  (`.env`, jamais commité).

## Format manuel / test

Le endpoint `/webhook` accepte aussi un appel explicite, utile pour tester :

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

`status` accepté : `running`/`pending` → en cours, `done`/`success` →
réussi, `failed`/`failure` → échoué, `error` → erreur.

## Structure du projet

```
index.js             serveur Express, routes, poller Dokploy, logique GitHub
store.js             historique persisté (JSON) des déploiements (par id GitHub)
auth.js              jetons de session/lien signés (HMAC), sans état serveur
deployment-page.js   page HTML de /deployments/:id (rendu + auth côté client)
admin-page.js        page HTML de /deployments (liste + santé, mot de passe requis)
Dockerfile           image de déploiement (node:20-alpine)
```

## Développement local

```bash
npm install
GITHUB_TOKEN=xxx \
WEBHOOK_SECRET=0123456789abcdef0123 \
GITHUB_OWNER=mv1234vm \
PUBLIC_URL=http://localhost:3000 \
DASHBOARD_PASSWORD=devpassword \
npm start
```

## Dépannage

| Symptôme | Piste |
| --- | --- |
| Aucune pastille sur GitHub | Vérifier les logs du service (`[webhook]`), la notification Dokploy, et que `GITHUB_TOKEN` a bien les permissions Deployments + Commit statuses |
| Pas de pastille 🔵 « en cours » | `DOKPLOY_URL` renseigné ? `POLL` pas à `off` ? Regarder les logs `[poll]` |
| `/deployments/:id` renvoie 404 | Le service a probablement redémarré depuis ce déploiement (historique en mémoire) — normal, pas un bug |
| Clic GitHub demande un mot de passe | Le lien a été généré avant que `PUBLIC_URL` soit configuré, ou le jeton a expiré (90 j) |
| Erreur GitHub 401/403 | Régénérer `GITHUB_TOKEN` avec les bonnes permissions |
| Rafale de nouveaux "Deployments" GitHub juste après un redémarrage | Normal si un déploiement s'est **réellement** terminé il y a moins de `CATCHUP_MAX_AGE_MS` (15 min par défaut) juste avant/pendant le redémarrage — c'est le filet de rattrapage qui fait son travail. Si ça concerne des commits bien plus anciens, vérifier `CATCHUP_MAX_AGE_MS` |
| `/health` renvoie `"ok": false` | Le sondage Dokploy échoue depuis plusieurs tentatives (`pollFailureStreak`/`lastPollError` dans la réponse) — vérifier que `DOKPLOY_API_KEY` n'a pas expiré et que `DOKPLOY_URL` est joignable |
| Bouton "Relancer" en erreur | Le déploiement n'a pas d'`applicationId` enregistré (créé avant cette mise à jour), ou l'endpoint `/api/application.deploy` a changé côté Dokploy — vérifier les logs `[retry]` |
