# Multi-OS Setup and Run Guide

This guide explains how to install, configure, and run the k6 **Orchestrator** and **Workers (Agents)** on **Windows**, **Linux** and **macOS**.

---

## 1. Global Prerequisites (on every machine)

### 1.1 Node.js
The project requires **Node.js (version 18 or higher)**.
* **Windows & macOS:** Download the official installer from [nodejs.org](https://nodejs.org/).
* **Linux (Ubuntu/Debian):**
  ```bash
  sudo apt update && sudo apt install -y nodejs npm
  ```

### 1.2 Grafana k6 (required on Worker machines only)
The `k6` binary must be available on the system PATH.

* **Windows:**
  * Via [Scoop](https://scoop.sh/): `scoop install k6`
  * Via [Winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/): `winget install Grafana.k6`
  * Or download the `.msi` installer from the [official k6 GitHub](https://github.com/grafana/k6/releases).

* **Linux (Ubuntu/Debian):**
  ```bash
  sudo gpg -k
  sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
  sudo apt update
  sudo apt install k6
  ```

* **macOS:**
  ```bash
  brew install k6
  ```

---

## 2. Project Installation

Run these steps on the Orchestrator's computer **and** on every Worker machine.

1. Create a folder for the project and place the corresponding folders inside it, depending on the target machine (`orchestrator` or `worker`).
2. Install the dependencies:
   ```bash
   npm install
   ```
3. For the orchestrator, build the web console (React / Next.js, `web/` folder):
   ```bash
   cd web
   npm install
   npm run build
   ```
   The orchestrator serves the build (`web/out`); if it is missing, a warning
   is printed at startup (the console would be empty).