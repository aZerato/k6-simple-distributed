# Guide de Configuration et d'Exécution Multi-OS

Ce guide explique comment installer, configurer et exécuter l'**Orchestrateur** et les **Workers (Agents)** k6 sur **Windows**, **Linux** et **macOS**.

---

## 1. Prérequis Globaux (Sur toutes les machines)

### 1.1 Node.js
Le projet nécessite **Node.js (version 18 ou supérieure)**.
* **Windows & macOS :** Téléchargez l'installeur officiel sur [nodejs.org](https://nodejs.org/).
* **Linux (Ubuntu/Debian) :** 
  ```bash
  sudo apt update && sudo apt install -y nodejs npm
  ```

### 1.2 Grafana k6 (Requis uniquement sur les machines Workers)
Le binaire `k6` doit être accessible dans le PATH du système.

* **Windows :**
  * Via [Scoop](https://scoop.sh/) : `scoop install k6`
  * Via [Winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/) : `winget install Grafana.k6`
  * Ou téléchargez l'installeur `.msi` depuis le [GitHub officiel de k6](https://github.com/grafana/k6/releases).

* **Linux (Ubuntu/Debian) :**
  ```bash
  sudo gpg -k
  sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
  sudo apt update
  sudo apt install k6
  ```

* **macOS :**
  ```bash
  brew install k6
  ```

---

## 2. Installation du Projet

Exécutez ces étapes sur l'ordinateur de l'Orchestrateur **et** sur chaque machine Worker.

1. Créez un dossier pour le projet et placez-y les dossiers correspondants (`orchestrator` ou `worker`).
2. Installez les dépendances :
   ```bash
   npm install
   ```
3. Générez la console web (React / Next.js, dossier `web/`) :
   ```bash
   cd web
   npm install
   npm run build
   ```
   L'orchestrateur sert le build (`web/out`) ; s'il est absent, un avertissement
   s'affiche au démarrage (la console serait vide).

---

## 3. Commandes d'Exécution par OS

Pour configurer les variables d'environnement (`ORCHESTRATOR_URL`, `WORKER_ID`, `PORT`), la syntaxe varie selon le système d'exploitation et le terminal utilisé.

### 3.1 Éxécution sur Windows

#### Option A : Via PowerShell (Recommandé sur Windows)
Dans PowerShell, les variables d'environnement doivent être définies sur des lignes distinctes avant de lancer le script :

* **Pour l'Orchestrateur :**
  ```powershell
  $env:PORT="3000"
  node orchestrator.js
  ```
* **Pour un Worker (Agent) :**
  ```powershell
  $env:ORCHESTRATOR_URL="http://<IP_ORCHESTRATEUR>:3000"
  $env:WORKER_ID="worker-windows-01"
  $env:PORT="4000"
  node worker.js
  ```

#### Option B : Via l'Invite de commandes classique (cmd.exe)
```cmd
:: Pour l'Orchestrateur
set PORT=3000
node orchestrator.js

:: Pour un Worker (Agent)
set ORCHESTRATOR_URL=http://<IP_ORCHESTRATEUR>:3000
set WORKER_ID=worker-windows-01
set PORT=4000
node worker.js
```

---

### 3.2 Éxécution sur Linux et macOS

Sur les systèmes de type Unix (Bash / Zsh), vous pouvez déclarer les variables d'environnement directement sur la même ligne, juste avant la commande Node.

* **Pour l'Orchestrateur :**
  ```bash
  PORT=3000 node orchestrator.js
  ```

* **Pour un Worker (Agent) :**
  ```bash
  ORCHESTRATOR_URL="http://<IP_ORCHESTRATEUR>:3000" WORKER_ID="worker-linux-01" PORT=4000 node worker.js
  ```

---

### 4. Test d'éxécution

* **Pour l'Orchestrateur :**
```shell
node \orchestrator\orchestrator.js
```

* **Pour un Worker (Agent) :**
```shell
node \worker\worker.js
```

Puis, depuis le navigateur de l'Orchestrateur, ouvrir **`http://localhost:3000`** (voir section 5) —
ou, via API vous pouvez déclencher le test de démonstration se trouvant ici :
```shell
node \orchestrator\test\trigger.js
```

---

## 5. Console web de l'Orchestrateur

Dès le démarrage, l'orchestrateur sert la console web sur **`http://<IP_ORCHESTRATEUR>:3000`**.
La console est une application **React / Next.js** (dossier `web/`, découpage par
composants — voir §6.1) : le build statique (`web/out`) est servi par Express, à la
même origine que l'API et Socket.io. Elle permet de :

* **Voir les graphiques en direct** (façon web dashboard de k6) : cartes de synthèse
  (VUS, req/s, échecs/s, checks %, itérations/s, données reçues/envoyées) avec
  sparklines, puis graphiques HTTP req/s + failed/s, données B/s, VUS et checks %.
  Chaque graphique porte la **courbe de fusion** (tous les workers) **et une courbe
  par worker** (en pointillés) : des **cases à cocher** sous chaque graphique
  permettent d'afficher/masquer chaque série ; le survol affiche la valeur de toutes
  les séries affichées à l'instant t.
* **Explorer les métriques** : un sélecteur liste toutes les métriques produites par
  k6 (ex. `http_req_duration`, `http_req_failed`…) ; pour chacune, le graphique
  avg + p95 (fusion **et une courbe avg/p95 par worker**) et le tableau de
  statistiques (count, rate, avg, p70/p80/p90/p95/p99, min, max) avec **une ligne
  par source** (fusion + une par worker).
* **Consulter les logs par worker** : chaque agent possède son onglet (pas de
  concaténation) avec horodatage millisecondes et type `STDOUT`/`STDERR`.
* **Lancer un test** (script k6 **collé** ou **pointé par un chemin `.js`**, VUS totales,
  durée) et **arrêter** un test d'urgence, directement depuis l'interface. Le chemin est
  lu sur la machine de l'orchestrateur puis injecté tel quel aux workers.
* **Télécharger le rapport** de la session :
  * **`.html`** — une page **autoportée** : graphiques SVG interactifs (infobulle avec la
    valeur à l'instant t au survol) pour les séries principales **et chaque métrique**
    (avg + p95), avec la courbe de fusion **et une courbe par worker** — des cases à
    cocher par graphique pour afficher/masquer chaque série. Synthèse, tableau de
    **toutes les métriques** (count, rate, min, avg, p70/p80/p90/p95/p99, max), et
    logs par worker. S'ouvre dans le navigateur, aucun serveur requis.
  * **`.json`** — le rapport complet : totaux (requêtes, échecs %, données, checks),
    statistiques finales de toutes les métriques (percentiles inclus), les séries
    horodatées par seconde (reconstruisables en graphiques, avec les valeurs **par
    worker** dans `byWorker`), les statistiques finales **par worker**, et les logs
    par worker.
  * **`.txt`** — le résumé lisible (session, code de sortie par worker, **métriques par
    worker** (VUS, requêtes, échecs, données, itérations), résumé global, métriques,
    logs).
  * **`JSON brut k6` (`.jsonl`)** — la sortie brute du `--out json=` de chaque worker,
    ligne par ligne (métadonnées + points de données, format JSON Lines), re-téléchargeable
    par session **et par worker** via le sélecteur du bandeau « Rapport ».
  
  Les 10 dernières sessions restent sélectionnables dans le menu déroulant du
  bandeau « Rapport ».
* **Suivre l'état des workers** (Disponible / Occupé) en temps réel.

### Métriques brutes k6 (`worker:metrics`)

Pour alimenter les graphiques, le worker lance k6 avec **`--out json=<fichier
éphémère>`** : chaque point de données k6 (une ligne JSON par requête/métrique)
est relu ligne à ligne par le worker puis streamé vers l'orchestrateur via l'événement
socket `worker:metrics` (`{ data: [ { metric, data: { value, count } } ] }`).
L'orchestrateur agrège les valeurs (taux/seconde, min/max, percentiles sur fenêtre
glissante de 5 000 valeurs) **globalement (fusion de tous les workers) et par
worker**, et diffuse un snapshot par seconde (`ui:metrics`) à la console : il porte
la courbe de fusion **et une courbe par worker**, avec les cases à cocher
d'affichage. Les VUS affichées sont la **somme des VUS actives de chaque worker**.
Les logs console de k6 continuent d'arriver via `worker:log`.

### API HTTP additionnelle (rapport & sessions)

| Méthode | Route                        | Description                                                        |
|--------|------------------------------|------------------------------------------------------------------|
| GET    | `/api/test/sessions`         | Liste des 10 dernières sessions (statut, VUS, durée, VUS max, workers) |
| GET    | `/api/test/report`           | Rapport JSON de la session en cours (ou de la dernière)             |
| GET    | `/api/test/report?format=txt`| Rapport texte (résumé) de la session en cours                       |
| GET    | `/api/test/report?format=html`| Rapport HTML autoporté (graphiques SVG + toutes les métriques)       |
| GET    | `/api/test/report?session=`  | Rapport d'une session précise (identifiant `sess-…`)               |
| GET    | `/api/raw-metrics`           | Sortie JSON brute k6 d'un worker (`?session=&worker=`, JSON Lines) |
| POST   | `/api/test/start`            | Lancement d'un test distribué (409 si un test est déjà en cours)   |
| POST   | `/api/test/stop`             | Arrêt d'urgence de tous les tests                                  |

> **Note :** un seul test est exécuté à la fois. Si une session est encore en cours
> (par exemple après un arrêt d'urgence, tant que k6 n'a pas émis son code de sortie),
> `POST /api/test/start` répond `409`.

## 6. Structure du code de l'Orchestrateur

Le code est découpé par responsabilité — « par controller / socket » — dans
`orchestrator/`. Le point d'entrée (`orchestrator.js`, ~40 lignes) ne fait que
câbler express + socket.io et lancer l'écoute ; tout le reste est importé :

| Module          | Rôle                                                                 |
|-----------------|----------------------------------------------------------------------|
| `orchestrator.js`| Point d'entrée : `app` + `io` + `listen` (assemblage des modules)      |
| `constants.js`  | Plafonds mémoire / console (sessions, logs, percentiles, JSON brut)    |
| `utils.js`      | Formatage partagé (horodatages, octets)                               |
| `state.js`      | Registre en mémoire : workers + sessions, source de vérité de la session courante et diffusions console |
| `metrics.js`    | Agrégation k6 (`MetricAgg`, percentiles, brut), fusion **+ par worker**, snapshot par seconde (`ui:metrics`) |
| `workers.js`    | Événements workers : logs k6 par worker (tampon de ligne) + clôture de fin de test |
| `scripts.js`    | Validation du script k6 (rejet des imports de modules Node.js)         |
| `reports/json.js`| Rapport JSON (séries + stats fusion/par worker + logs)                 |
| `reports/txt.js`| Rapport texte (résumé + métriques par worker)                          |
| `reports/html.js`| Rapport HTML autoporté (SVG + JS embarqué : cases à cocher, infobulle)  |
| `routes.js`     | API HTTP (controllers) : `registerRoutes(app, io)`                   |
| `sockets.js`    | Canal Socket.io : `registerSockets(io)` — workers + console web        |

Le worker (`worker/worker.js`) n'est pas concerné par ce découpage : il parle
uniquement le protocole socket (`worker:ready`, `worker:log`, `worker:metrics`,
`worker:test_finished`, …) et reste un fichier unique.

### 6.1 Console web (`web/`) — React / Next.js

La partie UI est découpée en **composants React** (un par panneau), avec le
même style CSS (porté dans `web/app/globals.css`).
Un seul état partagé (`hooks/useDashboard.js`) : socket `ui:*`, session affichée /
« piquetée » / RUNNING, snapshots, séries par worker, logs, watchdog « refresh
forcé » — les composants n'ont plus que leur rendu. Le canvas (graphiques,
sparklines, infobulle) reste un moteur impératif sans dépendance, dans
`lib/charts.js`.

| Fichier                           | Rôle                                                                          |
|-----------------------------------|-------------------------------------------------------------------------------|
| `app/layout.jsx` / `app/page.jsx` | Coquille (polices, CSS global) + assemblage de la page                        |
| `hooks/useDashboard.js`           | « Cerveau » : socket `ui:*`, sessions, rows, séries, logs, watchdog           |
| `lib/config.js`                   | URL de l'orchestrateur (`NEXT_PUBLIC_ORCHESTRATOR_URL`) + plafonds            |
| `lib/format.js`                   | Formatage (horodatages, nombres, octets)                                     |
| `lib/charts.js`                   | Moteur canvas (grille, courbes, sparklines, infobulle) + defs de séries       |
| `components/TopBar.jsx`           | Barre du haut (marque, compte de workers, LED socket)                         |
| `components/WorkersPanel.jsx`     | Liste des workers (statut Disponible / Occupé)                               |
| `components/TestForm.jsx`         | Lancement de test (script collé ou `scriptPath`, VUS, durée, stop)           |
| `components/Cards.jsx`            | Cartes de synthèse + sparklines canvas                                        |
| `components/ChartsGrid.jsx`       | 4 graphiques principaux + cases à cocher des séries (fusion + par worker)     |
| `components/MetricExplorer.jsx`   | Explorateur de métrique : graphique avg/p95 + tableau par source              |
| `components/LogsPanel.jsx`        | Logs par worker (onglets, auto-scroll, « Vider »)                             |
| `components/ReportStrip.jsx`      | Bandeau Rapport : sessions, JSON brut k6, téléchargements html/json/txt/jsonl  |