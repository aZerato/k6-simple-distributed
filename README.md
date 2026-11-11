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

---

## 3. Run Commands per OS

To set the environment variables (`ORCHESTRATOR_URL`, `WORKER_ID`, `PORT`), the syntax varies with the operating system and the terminal used.

### 3.1 Running on Windows

#### Option A: via PowerShell (recommended on Windows)
In PowerShell, the environment variables must be defined on separate lines before running the script:

* **For the Orchestrator:**
  ```powershell
  $env:PORT="3000"
  node orchestrator.js
  ```
* **For a Worker (Agent):**
  ```powershell
  $env:ORCHESTRATOR_URL="http://<IP_ORCHESTRATEUR>:3000"
  $env:WORKER_ID="worker-windows-01"
  $env:PORT="4000"
  node worker.js
  ```

#### Option B: via the classic Command Prompt (cmd.exe)
```cmd
:: For the Orchestrator
set PORT=3000
node orchestrator.js

:: For a Worker (Agent)
set ORCHESTRATOR_URL=http://<IP_ORCHESTRATEUR>:3000
set WORKER_ID=worker-windows-01
set PORT=4000
node worker.js
```

---

### 3.2 Running on Linux and macOS

On Unix-like systems (Bash / Zsh) you can declare the environment variables on the same line, just before the Node command.

* **For the Orchestrator:**
  ```bash
  PORT=3000 node orchestrator.js
  ```

* **For a Worker (Agent):**
  ```bash
  ORCHESTRATOR_URL="http://<IP_ORCHESTRATEUR>:3000" WORKER_ID="worker-linux-01" PORT=4000 node worker.js
  ```

---

### 4. Test run

* **For the Orchestrator:**
```shell
node \orchestrator\orchestrator.js
```

* **For a Worker (Agent):**
```shell
node \worker\worker.js
```

Then, from the Orchestrator's browser, open **`http://localhost:3000`** (see section 5) —
or, via the API, you can trigger the demo test located here:
```shell
node \orchestrator\test\trigger.js
```

---

## 5. Orchestrator Web Console

At startup, the orchestrator serves the web console on **`http://<IP_ORCHESTRATEUR>:3000`**.
The console is a **React / Next.js** application (`web/` folder, split per
component — see §6.1): the static build (`web/out`) is served by Express, on
the same origin as the API and Socket.io. It lets you:

* **Watch live charts** (k6 web-dashboard style): summary cards
  (VUS, req/s, failed/s, checks %, iterations/s, data received/sent) with
  sparklines, then HTTP req/s + failed/s charts, data B/s, VUS and checks %.
  Each chart carries the **fusion curve** (all workers) **and one curve
  per worker** (dashed): **checkboxes** under each chart
  let you show/hide every series; hovering shows the value of every
  visible series at time t.
* **Explore metrics**: a selector lists every metric produced by
  k6 (e.g. `http_req_duration`, `http_req_failed`…); for each one, an
  avg + p95 chart (fusion **and an avg/p95 curve per worker**) and a
  statistics table (count, rate, avg, p70/p80/p90/p95/p99, min, max) with **one row
  per source** (fusion + one per worker).
* **Inspect per-worker logs**: every agent has its own tab (no
  concatenation), with millisecond timestamps and `STDOUT`/`STDERR` type.
* **Start a test** (k6 script **pasted** or **pointed to by a `.js` path**, total VUS,
  duration) and **stop** a test as an emergency stop, directly from the interface. The path is
  read on the orchestrator's machine, then injected as-is to the workers.
* **Download the session report**:
  * **`.html`** — a **self-contained** page: interactive SVG charts (with a tooltip showing
    the value at time t on hover) for the main series **and every metric**
    (avg + p95), with the fusion curve **and one curve per worker** — checkboxes
    per chart to show/hide every series. Summary,
    **all-metrics** table (count, rate, min, avg, p70/p80/p90/p95/p99, max), and
    per-worker logs. Opens in a browser, no server required.
  * **`.json`** — the full report: totals (requests, failed %, data, checks),
    final statistics for every metric (percentiles included), the
    per-second timestamped series (reconstructable as charts, with the **per
    worker** values in `byWorker`), the final statistics **per worker**, and the
    per-worker logs.
  * **`.txt`** — the human-readable summary (session, exit code per worker, **per-worker
    metrics** (VUS, requests, failures, data, iterations), global summary, metrics,
    logs).
  * **`Raw k6 JSON` (`.jsonl`)** — the raw `--out json=` output of every worker,
    line by line (metadata + data points, JSON Lines format), re-downloadable
    per session **and per worker** via the "Report" strip selector.

  The 10 most recent sessions stay selectable in the dropdown of the
  "Report" strip.
* **Follow worker state** (Available / Busy) in real time.

### Raw k6 metrics (`worker:metrics`)

To feed the charts, the worker runs k6 with **`--out json=<ephemeral
file>`**: every k6 data point (one JSON line per request/metric)
is re-read line by line by the worker, then streamed to the orchestrator via the
`worker:metrics` socket event (`{ data: [ { metric, data: { value, count } } ] }`).
The orchestrator aggregates the values (rate/second, min/max, percentiles over a
sliding window of 5,000 values) **globally (fusion of every worker) and per
worker**, and broadcasts a snapshot per second (`ui:metrics`) to the console: it carries
the fusion curve **and one curve per worker**, with the show/hide
checkboxes. The displayed VUS are the **sum of every worker's active VUS**.
k6 console logs keep arriving via `worker:log`.

### Additional HTTP API (reports & sessions)

| Method | Route                        | Description                                                        |
|--------|------------------------------|------------------------------------------------------------------|
| GET    | `/api/test/sessions`         | List of the 10 most recent sessions (status, VUS, duration, max VUS, workers) |
| GET    | `/api/test/report`           | JSON report of the running session (or the last one)             |
| GET    | `/api/test/report?format=txt`| Text report (summary) of the running session                       |
| GET    | `/api/test/report?format=html`| Self-contained HTML report (SVG charts + every metric)       |
| GET    | `/api/test/report?session=`  | Report of a specific session (id `sess-…`)               |
| GET    | `/api/raw-metrics`           | Raw k6 JSON output of a worker (`?session=&worker=`, JSON Lines) |
| POST   | `/api/test/start`            | Start a distributed test (409 if a test is already running)   |
| POST   | `/api/test/stop`             | Emergency stop of all tests                                  |

> **Note:** only one test runs at a time. If a session is still in progress
> (e.g. after an emergency stop, as long as k6 has not emitted its exit code),
> `POST /api/test/start` answers `409`.

## 6. Orchestrator Code Structure

The code is split by responsibility — "per controller / socket" — in
`orchestrator/`. The entry point (`orchestrator.js`, ~40 lines) only
wires express + socket.io and starts listening; everything else is imported:

| Module          | Role                                                                 |
|-----------------|----------------------------------------------------------------------|
| `orchestrator.js`| Entry point: `app` + `io` + `listen` (module assembly)      |
| `constants.js`  | Memory / console caps (sessions, logs, percentiles, raw JSON)    |
| `utils.js`      | Shared formatting (timestamps, bytes)                               |
| `state.js`      | In-memory registry: workers + sessions, source of truth for the current session and console broadcasts |
| `metrics.js`    | k6 aggregation (`MetricAgg`, percentiles, raw), fusion **+ per worker**, per-second snapshot (`ui:metrics`) |
| `workers.js`    | Worker events: per-worker k6 logs (line buffer) + end-of-test close-out |
| `scripts.js`    | k6 script validation (rejects Node.js module imports)         |
| `reports/json.js`| JSON report (series + fusion/per-worker stats + logs)                 |
| `reports/txt.js`| Text report (summary + per-worker metrics)                          |
| `reports/html.js`| Self-contained HTML report (SVG + embedded JS: checkboxes, tooltip)  |
| `routes.js`     | HTTP API (controllers): `registerRoutes(app, io)`                   |
| `sockets.js`    | Socket.io channel: `registerSockets(io)` — workers + web console        |

The worker (`worker/worker.js`) is not part of this split: it only speaks
the socket protocol (`worker:ready`, `worker:log`, `worker:metrics`,
`worker:test_finished`, …) and remains a single file.

### 6.1 Web Console (`web/`) — React / Next.js

The UI part is split into **React components** (one per panel), with the
same CSS style (moved into `web/app/globals.css`).
A single shared state (`hooks/useDashboard.js`): socket `ui:*`, displayed session /
"pinned" / RUNNING, snapshots, per-worker series, logs, "forced
refresh" watchdog — the components only keep their rendering. The canvas (charts,
sparklines, tooltip) stays a dependency-free imperative engine, in
`lib/charts.js`.

| File                           | Role                                                                          |
|--------------------------------|------------------------------------------------------------------------------|
| `app/layout.jsx` / `app/page.jsx` | Shell (fonts, global CSS) + page assembly                        |
| `hooks/useDashboard.js`           | "Brain": socket `ui:*`, sessions, rows, series, logs, watchdog           |
| `lib/config.js`                   | Orchestrator URL (`NEXT_PUBLIC_ORCHESTRATOR_URL`) + caps            |
| `lib/format.js`                   | Formatting (timestamps, numbers, bytes)                                     |
| `lib/charts.js`                   | Canvas engine (grid, curves, sparklines, tooltip) + series defs       |
| `components/TopBar.jsx`           | Top bar (brand, worker count, socket LED)                         |
| `components/WorkersPanel.jsx`     | Worker list (status Available / Busy)                               |
| `components/TestForm.jsx`         | Test launch (pasted script or `scriptPath`, VUS, duration, stop)           |
| `components/Cards.jsx`            | Summary cards + canvas sparklines                                        |
| `components/ChartsGrid.jsx`       | 4 main charts + series checkboxes (fusion + per worker)     |
| `components/MetricExplorer.jsx`   | Metric explorer: avg/p95 chart + per-source table              |
| `components/LogsPanel.jsx`        | Per-worker logs (tabs, auto-scroll, "Clear")                             |
| `components/ReportStrip.jsx`      | Report strip: sessions, raw k6 JSON, html/json/txt/jsonl downloads  |
