# Architecture des Agents k6 Distribués (Node.js & WebSockets)

Ce document décrit l'architecture et le protocole de communication en temps réel entre l'**Orchestrateur** et les **Workers (Agents)** pour l'exécution distribuée de tests de charge k6, sans dépendre de Kubernetes.

## 1. Vue d'Ensemble de l'Architecture

Le système repose sur un modèle d'agents connectés en continu à l'orchestrateur via le protocole **WebSocket**. 

```
+------------------------------------------------------------+
|                        ORCHESTRATEUR                       |
|  (Serveur central avec Dashboard / Interface de Contrôle)   |
+-----------------------------+------------------------------+
                              |
         +--------------------+--------------------+
         | Connexion WebSocket bidirectionnelle    |
         v                                         v
+-------------------------+               +-------------------------+
|     WORKER (AGENT 1)    |               |     WORKER (AGENT 2)    |
|  [Node.js / Express]    |               |  [Node.js / Express]    |
|                         |               |                         |
|  +-------------------+  |               |  +-------------------+  |
|  | Processus k6      |  |               |  | Processus k6      |  |
|  +-------------------+  |               |  +-------------------+  |
+-------------------------+               +-------------------------+
```

### Avantages de cette approche :
* **Temps réel :** L'orchestrateur connaît instantanément l'état de chaque worker (Disponible, En cours de test, Déconnecté).
* **Flux de logs (Streaming) :** Les sorties consoles (`stdout`/`stderr`) de k6 sont capturées ligne par ligne et renvoyées à l'orchestrateur pour un affichage en direct.
* **Sécurité anti-injection :** Les workers n'acceptent pas de commandes système brutes. Ils exécutent *uniquement* le binaire officiel `k6` via des paramètres contrôlés.

---

## 2. Cycle de Vie d'un Test (Flux WebSocket)

1. **Connexion & Enregistrement :** Au démarrage, le worker Node.js se connecte à l'orchestrateur et s'enregistre (ex: `agent-zone-europe-1`).
2. **Ordre de test (`START_TEST`) :** L'orchestrateur envoie un payload JSON contenant le code du script k6 et les variables d'environnement ajustées pour ce worker (ex: nombre de VUs attribué).
3. **Exécution sécurisée :** Le worker écrit le script JS dans un fichier temporaire local et lance k6 de manière isolée.
4. **Remontée temps réel (`K6_LOG`) :** Chaque ligne générée par k6 est lue par Node.js et immédiatement poussée via WebSocket vers l'orchestrateur.
5. **Fin de test (`TEST_FINISHED`) :** Une fois le processus k6 terminé, le worker renvoie le code de sortie (0 pour succès, ou code d'erreur) et repasse en état "Disponible".

---

## 3. Sécurisation de l'Exécution (Contre l'injection de code)

Pour interdire l'exécution de commandes système malveillantes (ex: `rm -rf /` ou `curl http://malicious...`), le code du worker Express/Node.js applique les règles strictes suivantes :

* **Pas de Shell intermédiaire :** Le processus k6 est instancié via `child_process.spawn('k6', [...])` avec l'option `{ shell: false }`. Cela empêche l'injection d'opérateurs de commande comme `;`, `&&`, ou `|`.
* **Sanitisation des arguments :** Les arguments passés à k6 (comme la durée ou le nombre de VUs) sont castés explicitement (ex: `parseInt()`) ou validés par une Regex stricte avant d'être injectés dans la commande.
* **Fichier JS éphémère :** Le script JavaScript reçu est écrit tel quel dans un répertoire dédié à k6. k6 agissant comme un bac à sable JavaScript (sans accès aux API Node.js natives du système hôte comme `fs` ou `child_process`), le script ne peut pas compromettre la machine du worker.

---

## 4. Spécification Technique du Worker Node.js

Chaque agent embarque une application Node.js légère combinant **Express** (pour les bilans de santé (Healthchecks) et les configurations) et **ws** / **socket.io** (pour le canal de commande).

### Exemple conceptuel de l'exécution dans le Worker :

```javascript
// Extraction sécurisée et contrôle des paramètres reçus de l'orchestrateur
const safeVus = String(parseInt(payload.vus)); // Force un entier
const safeDuration = /^[0-9]+[smh]\$/.test(payload.duration) ? payload.duration : '10s'; // Valide le format (ex: 5m, 30s)

// Écriture du script k6 reçu de manière sécurisée
fs.writeFileSync('/tmp/test_load.js', payload.scriptJavaScript);

// Lancement sécurisé (Pas de shell, arguments encapsulés dans un tableau)
const k6Process = spawn('k6', [
  'run', 
  '--vus', safeVus, 
  '--duration', safeDuration, 
  '/tmp/test_load.js'
], { shell: false });

// Capture et envoi des flux en temps réel à l'orchestrateur
k6Process.stdout.on('data', (data) => {
  webSocket.send(JSON.stringify({ event: 'K6_LOG', type: 'stdout', text: data.toString() }));
});

k6Process.stderr.on('data', (data) => {
  webSocket.send(JSON.stringify({ event: 'K6_LOG', type: 'stderr', text: data.toString() }));
});

k6Process.on('close', (code) => {
  webSocket.send(JSON.stringify({ event: 'TEST_FINISHED', exitCode: code }));
});
```

---

## 5. Centralisation des Métriques de Performance

Bien que les logs de la console (`stdout`) remontent en temps réel via le WebSocket pour le monitoring visuel, les métriques brutes de charge (temps de réponse, requêtes/sec) générées par k6 doivent être envoyées en parallèle vers un serveur de stockage externe de manière performante.

Chaque worker configurera son exécution k6 pour pousser les métriques vers le stockage de votre choix (ex: InfluxDB, Prometheus Remote Write, ou même un serveur d'ingestion géré par votre orchestrateur) à l'aide de l'option `--out`.
