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

1. Créez un dossier pour le projet et placez-y les fichiers correspondants (`orchestrator.js` ou `worker.js`).
2. Créez le fichier `package.json` adapté (voir codes précédents).
3. Installez les dépendances :
   ```bash
   npm install
   ```

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

Puis retourner sur l'Orchestrateur :
```shell
node \orchestrator\test\trigger.js
```