# dokploy-github-status

[![License: MIT](https://img.shields.io/badge/license-MIT-ea580c.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-16a34a.svg)](Dockerfile)
[![Zero dependency](https://img.shields.io/badge/dependencies-Express%20only-blue.svg)](package.json)
[![Tests: node:test](https://img.shields.io/badge/tests-node%3Atest-brightgreen.svg)](test/)

**Vercel/Netlify-style deployment status for Dokploy.** Un petit service
Express, sans base de données, qui relie **Dokploy** à **GitHub** : à chaque
déploiement, il pose sur le commit la pastille ✅ / 🟠 / ❌ que GitHub affiche
nativement — avec en plus une vraie page de détail par déploiement et un
tableau de bord santé pour tous tes sites.

Zéro dépendance en dehors d'Express, zéro configuration par app : le service
découvre lui-même le repo GitHub de chaque application Dokploy.

```
   git push
      │
      ▼                     "je déploie" / "c'est fini"
┌──────────┐   déploie   ┌──────────┐   webhook / poll   ┌───────────────────────┐
│  GitHub  │ ──────────► │ Dokploy  │ ──────────────────►│ dokploy-github-status │
└──────────┘             └──────────┘                    │      (ce service)     │
      ▲                                                   └───────────┬───────────┘
      │ pose la pastille + un lien "Details"                          │
      └────────────────────────────────────────────────────────────────┘
                          GET /deployments/:id  ← ce que "Details" ouvre
```

## Pourquoi

Dokploy ne pose pas nativement de statut sur les commits GitHub — pas de
pastille ✅/❌ dans l'historique, pas de check sur les PR, pas de lien direct
vers le déploiement correspondant à un commit. Ce service comble ce manque,
exactement comme le fait Vercel ou Netlify sur leurs intégrations GitHub,
sans rien ajouter à l'infrastructure (pas de DB, pas de queue, un seul
conteneur Node).

## Sommaire

- [Ce que fait le service](#ce-que-fait-le-service)
- [Mise en place](#mise-en-place)
- [Variables d'environnement](#variables-denvironnement)
- [Routes](#routes)
- [Fonctionnement interne](#fonctionnement-interne)
- [Statut « en cours »](#statut--en-cours-)
- [Page de détail `/deployments/:id`](#page-de-détail-deploymentsid)
- [Tableau de bord `/deployments`](#tableau-de-bord-deployments)
- [Persistance](#persistance)
- [Sécurité](#sécurité)
- [Tests](#tests)
- [Fiabilité](#fiabilité)
- [Test manuel](#test-manuel)
- [Structure du projet](#structure-du-projet)
- [Développement local](#développement-local)
- [Dépannage](#dépannage)
- [Contribuer](#contribuer)
- [Licence](#licence)

---

## Ce que fait le service

1. **Détecte** qu'une app Dokploy commence, réussit ou échoue un déploiement
   (webhook Dokploy + sondage périodique de l'API Dokploy en filet de
   sécurité).
2. **Retrouve** tout seul à quel repo/branche/commit GitHub ça correspond.
3. **Pose le statut** sur GitHub :
   - un **commit status** (`context: "Dokploy"`) → la pastille à côté du
     commit et dans les checks d'une PR ;
   - un vrai **GitHub Deployment** → visible dans l'onglet *Environments* du
     repo.
4. Le lien **Details** de ce statut ouvre une **page dédiée** générée par ce
   service, pas les logs bruts de Dokploy.

Le token GitHub, la clé API Dokploy et le mot de passe du tableau de bord ne
sont **jamais** exposés au navigateur.

## Mise en place

### 1. Déployer ce service sur Dokploy
- **Create Application** → Git → ce repo → build **Dockerfile**
- **Domains** : générer un domaine, port `3000`, HTTPS activé

### 2. Générer le token GitHub
Fine-grained PAT avec, sur les repos concernés : **Contents = Read**,
**Deployments = Read/Write**, **Commit statuses = Read/Write**.

### 3. Générer la clé API Dokploy
Dokploy → **Settings → Profile** → section *API/CLI* → *Generate* (laisse le
rate limiting vide) → copie la clé immédiatement, elle ne se réaffiche pas.

### 4. Renseigner l'environnement du service
```bash
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
commit GitHub reçoit sa pastille, cliquable vers sa page de détail. L'URL et
le header webhook pour une nouvelle app sont aussi récupérables directement
depuis le panneau *Configuration* du tableau de bord (`/deployments`).

## Variables d'environnement

| Variable | Requis | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | **oui** | PAT fine-grained : Contents=Read, Deployments=R/W, Commit statuses=R/W |
| `WEBHOOK_SECRET` | **oui** | Secret partagé (≥ 16 car.), attendu dans le header `x-webhook-secret`. Sert aussi de clé de signature pour les jetons des pages `/deployments/:id`. |
| `DOKPLOY_API_KEY` | oui* | Clé API Dokploy — permet de retrouver seul le repo GitHub de chaque app |
| `DOKPLOY_URL` | non | URL du Dokploy — sinon déduite automatiquement de la 1ʳᵉ notification reçue |
| `GITHUB_BRANCH` | non | Branche par défaut si Dokploy n'en précise pas (défaut `main`) |
| `GITHUB_OWNER` | non | Fallback si pas de `DOKPLOY_API_KEY` : compte GitHub, repo = nom de l'app Dokploy |
| `APP_MAP` | non | Fallback JSON pour les exceptions : `{"nom-app":"owner/repo"}` ou `{"nom-app":"owner/repo@branche"}` |
| `GITHUB_WEBHOOK_SECRET` | non | Active `POST /github` (webhook push GitHub) pour un statut « en cours » instantané |
| `POLL` | non | `off` pour désactiver le sondage périodique de Dokploy (défaut `on`) |
| `POLL_INTERVAL_MS` | non | Fréquence du sondage, en ms (défaut `5000`, plancher `2000`) |
| `CATCHUP_MAX_AGE_MS` | non | Le rattrapage de statuts manqués ne concerne que les déploiements finis il y a moins de X ms (défaut 15 min) |
| `PUBLIC_URL` | non | URL publique de **ce service**, sans `/` final — active les pages `/deployments/:id` |
| `DASHBOARD_PASSWORD` | non | Mot de passe pour l'accès direct à `/deployments/:id` et pour tout `/deployments` (liste, santé, relance) |
| `DATA_DIR` | non | Dossier où persister les données JSON (défaut `./data`) — voir [Persistance](#persistance) |
| `SELF_APPLICATION_ID` | non | `applicationId` Dokploy de **ce service lui-même** — permet à la rotation de mot de passe de réécrire `DASHBOARD_PASSWORD` dans l'environnement Dokploy |
| `OUTGOING_WEBHOOK_URL` | non | URL appelée en `POST` (JSON) à chaque changement de statut, pour brancher un outil tiers |

\* Il faut `DOKPLOY_API_KEY` **ou** `GITHUB_OWNER`/`APP_MAP` (au moins un des
deux).

## Routes

| Route | Rôle |
| --- | --- |
| `POST /webhook` | Notification Dokploy (fin de déploiement) |
| `POST /github` | Webhook GitHub *push* optionnel, statut « en cours » instantané |
| `GET /deployments/:id` | Page de détail d'un déploiement (HTML) |
| `GET /api/deployments/:id` | Données JSON d'un déploiement, protégées par jeton (lien ou session) |
| `GET /deployments` | Tableau de bord : liste + santé de tous les sites (HTML, **mot de passe requis**) |
| `GET /api/deployments` | Liste paginée/filtrable + santé + stats, **jeton de session uniquement** |
| `POST /api/deployments/:id/retry` | Relance le déploiement via l'API Dokploy, **session uniquement**, anti-spam 1/30s |
| `POST /api/repos/:owner/:repo/mute` | Bascule le mode maintenance d'un repo, **session uniquement** |
| `GET /api/audit-log` | Historique des connexions/relances/mots de passe, filtrable, **session uniquement** |
| `GET /api/webhook-config` | URL + header webhook prêts à copier pour une nouvelle app, **session uniquement** |
| `POST /api/change-password` | Change `DASHBOARD_PASSWORD` (ancien mot de passe requis), **session uniquement** |
| `POST /api/login` | Échange un mot de passe contre un jeton de session |
| `GET /manifest.json` | Manifest PWA ("Ajouter à l'écran d'accueil") |
| `GET /health` | Disponibilité + état du sondage Dokploy |
| `GET /` | Page d'accueil du service |

## Fonctionnement interne

Dokploy n'envoie ni le repo GitHub ni le SHA dans sa notification — juste le
nom de l'app et un lien vers son tableau de bord. Le service :

1. extrait l'`applicationId` de ce lien et interroge l'API Dokploy pour
   obtenir `owner`/`repo`/`branch` (repli sur `APP_MAP` puis `GITHUB_OWNER`) ;
2. récupère le dernier commit de la branche via l'API GitHub (ou le commit
   exact enregistré par Dokploy, pour un rattrapage a posteriori) ;
3. crée un **GitHub Deployment** (réutilisé pour tout le cycle
   pending→final d'un même commit, jamais un nouveau par statut), enregistre
   une fiche locale, puis pose le **deployment status** et le **commit
   status**, avec `target_url`/`log_url` pointant vers `/deployments/<id>`.

## Statut « en cours »

Dokploy ne notifie **qu'à la fin** d'un déploiement — sans rien de plus, la
pastille passerait directement de rien à ✅/❌. Deux mécanismes, cumulables :

**Sondage automatique** (actif par défaut) — le service interroge l'API
Dokploy toutes les `POLL_INTERVAL_MS` (5 s). Dès qu'un déploiement passe à
`running`, il pose `pending`/`in_progress`. Désactiver : `POLL=off`.

**Webhook GitHub push** (optionnel, plus instantané) :
1. Génère un secret, mets-le dans `GITHUB_WEBHOOK_SECRET` → Redeploy.
2. GitHub → repo/organisation → **Settings → Webhooks → Add webhook** :
   Payload URL `https://<ton-domaine>/github`, type `application/json`,
   même secret, événement *Just the push event*.

## Page de détail `/deployments/:id`

Chaque déploiement a sa propre page, à l'identifiant GitHub réel — jamais une
page générique qui mélangerait plusieurs déploiements.

**Contenu** : statut coloré (🟠 en cours / 🟢 réussi / 🔴 échoué), projet,
branche, commit, environnement, dates, durée, timeline des changements
d'état, liens vers GitHub / le commit / le déploiement précédent (comparaison
de diff) / le site déployé / les logs Dokploy. Rafraîchissement auto toutes
les 5 s tant que le déploiement est en cours. Bouton **Relancer** sur un
échec (voir plus bas). Thème clair/sombre manuel (🌓).

**Accès depuis GitHub — sans mot de passe.** Le lien *Details* est de la
forme `https://<PUBLIC_URL>/deployments/<id>?t=<jeton>` : un jeton HMAC-SHA256
(90 jours) **scopé à ce seul déploiement** — volé ou partagé, il ne donne
accès à rien d'autre, vérifié côté serveur à chaque requête.

**Accès direct — avec mot de passe.** Ouvrir l'URL sans jeton affiche un
écran de mot de passe (5 tentatives/minute/IP). Une fois validé, un jeton de
**session** (30 jours, accès à *tous* les déploiements) est stocké dans
`localStorage` — jamais le mot de passe lui-même.

Sans `PUBLIC_URL`, cette page est inactive et les liens *Details* pointent
vers les logs Dokploy comme avant.

## Tableau de bord `/deployments`

Liste des derniers déploiements + état de santé de chaque site — **toujours**
protégé par mot de passe : contrairement à `/deployments/:id`, un jeton de
lien GitHub ne donne **jamais** accès ici, seul `DASHBOARD_PASSWORD` (jeton
de session) le permet.

**Vue d'ensemble**
- Frise d'activité globale (tous sites), un point coloré par déploiement.
- Par site : sparkline des déploiements/jour (14 j), taux de succès (20
  derniers), durée moyenne de build — un `pending` qui dépasse 1,5× cette
  moyenne est signalé en rouge. Badge d'ancienneté (orange au-delà de 30 j
  sans déploiement).
- Filtre par repo/app et par statut, **partageable par URL**
  (`?status=failure&search=bischwihr`, bouton 🔗 pour copier le lien) ;
  liste paginée (50/page, "Charger plus").
- Export JSON/CSV de l'historique affiché (généré côté navigateur).
- Mode **maintenance** par repo (bouton dans la santé) : purement cosmétique,
  ne touche à rien côté GitHub/Dokploy.
- Raccourcis clavier `/` (recherche) et `r` (rafraîchir) ; PWA installable
  (`/manifest.json`) ; thème clair/sombre manuel.
- **Alerte navigateur sur nouvel échec** : favicon qui passe au rouge (si
  l'onglet est en arrière-plan) + notification navigateur si autorisée
  (bouton 🔔). Volontairement local au navigateur — pas de
  Slack/Discord/email.

**Relancer un déploiement échoué** — bouton **Relancer** (visible seulement
en session mot de passe) déclenche `POST /api/application.deploy` côté
Dokploy pour l'`applicationId` du déploiement. Anti-spam : 1 relance / 30 s
par application.

**Panneau Configuration** (dépliable) — URL de webhook et header
`x-webhook-secret` prêts à copier-coller dans Dokploy pour une nouvelle app,
avec un exemple `curl` complet. Derrière la session uniquement : le secret
n'est jamais exposé sur une page publique.

**Panneau Sécurité** (dépliable)
- **Rotation du mot de passe** (ancien requis, 8 caractères minimum). Sans
  `SELF_APPLICATION_ID`, le changement reste en mémoire et se perd au
  prochain redéploiement (avertissement explicite affiché) ; avec elle, le
  service réécrit lui-même `DASHBOARD_PASSWORD` dans l'environnement Dokploy,
  et n'applique le changement que si cette écriture réussit.
- **Journal d'audit** : connexions réussies/échouées, relances, changements
  de mot de passe, avec IP et horodatage (200 entrées max) — filtrable par
  type, IP ou date.

## Persistance

L'historique (300 déploiements les plus récents) est sauvegardé en JSON dans
`DATA_DIR` (défaut `./data`), rechargé au démarrage. Ça survit à un
**redémarrage du process** dans le même conteneur. Ça ne survit **pas** à un
**redéploiement** (nouvelle image = nouveau conteneur = disque vierge), sauf
si `DATA_DIR` pointe vers un **volume Dokploy monté** (bind mount recommandé,
type `volume` fonctionne aussi) — sans ça, un redéploiement de ce service
repart de zéro et les anciennes pages renvoient un 404 propre plutôt que
d'inventer des données.

## Sécurité

- `x-webhook-secret` et signature `x-hub-signature-256` comparés en temps
  constant (`crypto.timingSafeEqual`).
- Mot de passe jamais renvoyé au client ni stocké en clair côté navigateur ;
  throttle anti brute-force (5 tentatives/minute/IP).
- `/api/deployments/:id` vérifie l'authentification **avant** de regarder si
  l'id existe : impossible d'énumérer les ids valides sans être authentifié.
- Jetons de lien scopés à un seul `id`, jetons de session distincts —
  jamais interchangeables ; les routes du tableau de bord (`/api/deployments`,
  retry, mute, audit-log, change-password) n'acceptent **que** la session.
- Le service refuse de démarrer sans `GITHUB_TOKEN`/`WEBHOOK_SECRET` (≥ 16
  caractères) ou sans moyen de résoudre les repos.
- `owner`/`repo`/`branch`/identifiants validés par regex ; corps JSON ≤ 1 Mo ;
  timeout 10 s sur tous les appels sortants ; `x-powered-by` désactivé.
- Rate-limit par IP sur `/webhook` et `/github` (60/min), en plus du secret
  déjà requis.
- Erreurs GitHub/Dokploy loggées côté serveur uniquement, jamais renvoyées
  au client.
- `npm audit` : 0 vulnérabilité (Express 5, aucune autre dépendance).
- À exposer uniquement en HTTPS ; secrets hors du dépôt (`.env` jamais
  commité).

Une vulnérabilité à signaler ? Ouvre une issue GitHub en décrivant le
problème sans détails d'exploitation publics si c'est sensible, ou contacte
directement le mainteneur.

## Tests

```bash
npm test
```

Tests unitaires (`node:test`, aucune dépendance supplémentaire) sur
`store.js` (persistance, filtres, stats, santé par repo) et `auth.js`
(signature/vérification des jetons, expiration, falsification). Pas de
tests d'intégration sur les routes HTTP — vérifiées manuellement via curl à
chaque changement (voir [Test manuel](#test-manuel)).

## Fiabilité

- **Pending qui ne se referme jamais** : si un commit B est poussé pendant
  que le déploiement de A tourne encore, Dokploy ne construit que B — A
  resterait bloqué en 🟠. Le service referme automatiquement l'ancien pending
  dès qu'un nouveau lui succède sur le même repo.
- **Statuts jamais posés** (webhook manqué) : appels GitHub réessayés (2
  tentatives, backoff) sur erreur réseau/5xx. Le sondage périodique sert de
  filet de rattrapage, y compris pour un déploiement déjà vu en `running` par
  ce service : si le webhook Dokploy ne pose pas le statut final dans les 90
  secondes qui suivent sa fin (notification perdue, secret désynchronisé…),
  le poller le pose lui-même — un déploiement ne reste plus bloqué en 🟠
  indéfiniment juste parce que le webhook a échoué une fois.
- **Rafale au redémarrage** évitée par `CATCHUP_MAX_AGE_MS` : seuls les
  déploiements terminés récemment sont rattrapés, pas tout l'historique.
- **Alerte poller en panne** : `/health` expose `pollFailureStreak` /
  `lastPollError` si le sondage Dokploy échoue en continu (clé API expirée…).

## Test manuel

`/webhook` accepte un appel explicite, utile pour tester :

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
index.js             serveur Express : routes, poller Dokploy, logique GitHub
store.js             historique persisté (JSON) des déploiements + stats
audit-log.js         journal d'audit persisté (connexions, relances, mot de passe)
mute.js              liste persistée des repos en mode maintenance
auth.js              jetons de session/lien signés (HMAC), sans état serveur
landing-page.js      page HTML de / (vitrine publique)
deployment-page.js   page HTML de /deployments/:id (rendu + auth côté client)
admin-page.js        page HTML de /deployments (tableau de bord)
test/                tests unitaires (node:test) sur store.js et auth.js
Dockerfile           image de déploiement (node:20-alpine, avec HEALTHCHECK)
```

## Développement local

```bash
git clone https://github.com/mv1234vm/dokploy-github-status.git
cd dokploy-github-status
npm install
GITHUB_TOKEN=xxx \
WEBHOOK_SECRET=0123456789abcdef0123 \
GITHUB_OWNER=ton-compte-github \
PUBLIC_URL=http://localhost:3000 \
DASHBOARD_PASSWORD=devpassword \
npm start
```

## Dépannage

| Symptôme | Piste |
| --- | --- |
| Aucune pastille sur GitHub | Logs `[webhook]`, notification Dokploy configurée, `GITHUB_TOKEN` avec les bonnes permissions |
| Pas de pastille 🟠 « en cours » | `DOKPLOY_URL` renseigné ? `POLL` pas à `off` ? Logs `[poll]` |
| `/deployments/:id` renvoie 404 | Le service a redémarré/redéployé sans volume persistant depuis ce déploiement — normal |
| Clic GitHub demande un mot de passe | Lien généré avant `PUBLIC_URL`, ou jeton expiré (90 j) |
| Erreur GitHub 401/403 | Régénérer `GITHUB_TOKEN` avec les bonnes permissions |
| Rafale de "Deployments" GitHub après un redémarrage | Normal si des déploiements se sont terminés il y a moins de `CATCHUP_MAX_AGE_MS` — c'est le rattrapage qui fonctionne |
| `/health` renvoie `"ok": false` | Sondage Dokploy en échec continu — vérifier `DOKPLOY_API_KEY`/`DOKPLOY_URL` |
| Bouton "Relancer" en erreur | Déploiement sans `applicationId` (antérieur à cette fonctionnalité), ou API Dokploy changée — logs `[retry]` |
| Rotation de mot de passe non permanente | `SELF_APPLICATION_ID` non configuré — le changement reste en mémoire jusqu'au prochain redéploiement |

## Contribuer

Les PR et issues sont bienvenues. Avant de proposer un changement :
- `npm test` doit passer ;
- pas de nouvelle dépendance sans bonne raison (c'est un choix assumé du
  projet : Express seul, zéro base de données) ;
- si tu touches à la logique du poller/webhook, explique le scénario de bug
  visé dans la description de la PR — ce service a un historique de bugs
  subtils sur la gestion des statuts "en cours" et des rattrapages.

## Licence

[MIT](LICENSE) — utilise, modifie, redistribue librement.
