# Architecture of Distributed k6 Agents (Node.js & WebSockets)

This document describes the architecture and the real-time communication protocol between the **Orchestrator** and the **Workers (Agents)** for the distributed execution of k6 load tests, without depending on Kubernetes.

## 1. Architecture Overview

The system is based on an agent model continuously connected to the orchestrator via the **WebSocket** protocol.

```
+------------------------------------------------------------+
|                        ORCHESTRATOR                        |
| (Central server with Dashboard / Control Interface)         |
+-----------------------------+------------------------------+
                              |
         +--------------------+--------------------+
         | Bidirectional WebSocket connection        |
         v                                         v
+-------------------------+               +-------------------------+
|     WORKER (AGENT 1)    |               |     WORKER (AGENT 2)    |
|  [Node.js / Express]    |               |  [Node.js / Express]    |
|                         |               |                         |
|  +-------------------+  |               |  +-------------------+  |
|  | k6 process        |  |               |  | k6 process        |  |
|  +-------------------+  |               |  +-------------------+  |
+-------------------------+               +-------------------------+
```

### Advantages of this approach:
* **Real-time:** The orchestrator instantly knows the state of each worker (Available, Test in progress, Disconnected).
* **Log streaming:** The console outputs (`stdout`/`stderr`) of k6 are captured line by line and sent back to the orchestrator for live display.
* **Anti-injection security:** The workers do not accept raw system commands. They run *only* the official `k6` binary via controlled parameters.
* **Targeted execution:** a test can be launched against **all** or **a subset** of the available workers, with the VUS distributed only across the targeted ones.

---

## 2. Test Lifecycle (WebSocket Flow)

1. **Connection & registration:** At startup, the Node.js worker connects to the orchestrator (Socket.io, auth `{ workerId }`) and announces itself with `worker:ready` (`{ status }`); the link is self-healing (infinite reconnection, 2 s delay).
2. **Test order (`orchestrator:start_test`):** The orchestrator sends each **targeted worker** a JSON payload `{ scriptContent, vus, duration, envVariables, attachments }` — the payload carries the **load profile** tailored to that worker: `vus` + `duration` (constant-vus) or `startVUs` + `stages` (ramping-vus); the VUS are distributed **only across the targeted workers** (see §2.1), and `attachments` carries the uploaded data files (see §2.2).
3. **Secure execution:** The worker creates a **per-test working directory** — `test-<timestamp>/` inside its ephemeral files directory (`WORKER_TMP_DIR` env var, default: the OS temp dir) — and writes the JS script, the uploaded data files, when any, and the raw metrics output there (next to each other, so relative paths in the script resolve like a local run), sanitizes the arguments, and launches k6 in isolation (`{ shell: false }`), then announces `worker:status_changed` (`BUSY`). The whole directory is deleted at the end of the test. A refusal (already busy, missing script, invalid data file) is answered with `worker:error`.
4. **Real-time upload (`worker:log`):** Every `stdout`/`stderr` chunk produced by k6 is pushed over the WebSocket to the orchestrator for live display.
5. **Raw metrics (`worker:metrics`):** In parallel, k6 writes its data points to an ephemeral file (`--out json=`), which the worker re-reads line by line and batches to the orchestrator (see §5).
6. **Emergency stop (`orchestrator:stop_test`):** The orchestrator can interrupt the test at any time; the worker sends `SIGINT` to the k6 process.
7. **End of test (`worker:test_finished`):** Once the k6 process exits, the worker sends back `{ exitCode }`, cleans up its ephemeral files, and goes back to the "Available" state (`worker:status_changed`).

#### 2.1 Targeted execution (worker selection)

`POST /api/test/start` accepts an optional `workerIds`:

* **absent / empty** → every **available** worker (backward compatible);
* unknown worker → `400`, worker not available → `422`, empty selection → `422`.

The VUS are fairly distributed **only across the targeted workers** (the
first one receives the remainder of the division); for a ramping-vus profile
the same split is applied to `startVUs` and to the `target` of every stage.
A worker that would receive 0 VU at its peak is simply not targeted, and if
no worker can be targeted the request answers `422`. The response carries the selection back
(`workersCibles` + `workerIds`). In the web console, each worker has a
checkbox (default: all) with *All / None* shortcuts, and "Start" is
disabled when none is selected.

#### 2.2 Data files (CSV, etc.) — upload to the workers' tmp dir

A script may reference local data files (e.g. `open('./data.csv')`, as in the
`SharedArray` + PapaParse example). `POST /api/test/start` accepts an optional
`attachments`: an object `name -> base64 content`, filled by the web console
(file picker; the files are read as base64 in the browser and never touch the
orchestrator's disk):

* at most **20 files**, **10 MB total** (the JSON body cap is raised to 20 MB) —
  beyond that the request answers `413`;
* names are sanitized on both sides (no path separators, no `.` / `..`, no
  empty name) — an invalid name answers `400`;
* the orchestrator forwards the files in the `start_test` payload; each worker
  writes them **next to the ephemeral script** (in its per-test working
  directory, see §2 step 3) and deletes the whole directory at the end of the
  test.

Relative paths in the script therefore behave exactly like a local `k6 run`:
upload `data.csv` and keep `open('./data.csv')` unchanged. A script can also
take the file name from the environment — e.g. `open(__ENV.CSV_FILE_PATH)` — so
one script runs against different data files; the scenario runner
(`orchestrator/test/scenario-runner.js`) does exactly that: it uploads each
scenario's data files and passes their names as `__ENV` variables. The same
runner sends the scenario's load profile as JSON to the API — in k6 v2 the
profile is CLI-only (see §4), so no `options` are injected into the script.

---

## 3. Execution Hardening (Against code injection)

To forbid the execution of malicious system commands (e.g. `rm -rf /` or `curl http://malicious...`), the worker's Express/Node.js code applies the following strict rules:

* **No intermediate Shell:** The k6 process is instantiated via `child_process.spawn('k6', [...])` with the `{ shell: false }` option. This prevents the injection of command operators such as `;`, `&&`, or `|`.
* **Argument sanitization:** The arguments passed to k6 (such as the duration or the number of VUs) are explicitly cast (e.g. `parseInt()`) or validated by a strict Regex before being injected into the command.
* **Ephemeral JS file:** The received JavaScript script is written as-is into the worker's per-test working directory (`WORKER_TMP_DIR`, default: the OS temp dir). k6 acting as a JavaScript sandbox (with no access to the host system's native Node.js APIs such as `fs` or `child_process`), the script cannot compromise the worker's machine.

---

## 4. Technical Specification of the Node.js Worker

Each agent ships a lightweight Node.js application combining **Express** (for health checks) and **Socket.io-client** (for the command channel).

### Conceptual example of the execution in the Worker:

```javascript
// Secure extraction and control of the parameters received from the orchestrator
const safeVus = String(parseInt(payload.vus)); // Forces an integer
const safeDuration = /^[0-9]+[smh]$/.test(payload.duration) ? payload.duration : '10s'; // Validates the format (e.g. 5m, 30s)

// Secure writing of the received k6 script
fs.writeFileSync('/tmp/test_load.js', payload.scriptContent);

// Secure launch (no shell, arguments encapsulated in an array)
const k6Process = spawn('k6', [
  'run',
  '--vus', safeVus,
  '--duration', safeDuration,
  '--out', 'json=/tmp/metrics.json', // raw data points, re-read and streamed
  '/tmp/test_load.js'
], { shell: false });

// Capture and real-time streaming of the outputs to the orchestrator
k6Process.stdout.on('data', (data) => {
  socket.emit('worker:log', { type: 'stdout', output: data.toString() });
});

k6Process.stderr.on('data', (data) => {
  socket.emit('worker:log', { type: 'stderr', output: data.toString() });
});

k6Process.on('close', (code) => {
  socket.emit('worker:test_finished', { exitCode: code });
});
```

> **k6 v2:** the load profile is **CLI-only** — the script's `options` are
> ignored. The worker builds `--vus <n> --duration <d>` for a constant-vus
> profile, or `--vus <startVUs> --stage <d>:<t> …` for a ramping-vus one
> (one `--stage` per stage, in order).

---

## 5. Centralization of Performance Metrics

Although the console logs (`stdout`) are streamed in real time over the WebSocket for visual monitoring, the raw load metrics (response times, requests/sec) generated by k6 take a dedicated, parallel path — and everything is aggregated **in memory** in the orchestrator (no external storage server):

1. The worker runs k6 with **`--out json=<ephemeral file>`**: every data point (one JSON line per request/metric) is written to disk.
2. The worker re-reads that file line by line (500 ms drain, offset tracking, last unfinished line kept) and batches the parsed items to the orchestrator via `worker:metrics` (`{ data: [...] }`). If the orchestrator is unreachable, the buffer is capped at 100 000 lines (oldest dropped).
3. The orchestrator aggregates the values (rate/second, min/max, percentiles over a sliding window of 5 000 values) — **globally (fusion of every worker) and per worker**.
4. Once per second, it broadcasts a snapshot (`ui:metrics`) to the web console: the fusion curve **and one curve per worker**, plus the summary cards (the displayed VUS are the sum of every worker's active VUS).

---

## 6. Web Console & Curve Visibility

The console (`web/`, React / Next.js) is served statically by the orchestrator on the same origin as the API and Socket.io (see `web/README.md` for the component split). Every chart draws the **fusion curve** (all workers) **and one curve per worker** (dashed), and per-chart checkboxes let you show/hide any series.

A global **"Curves"** control (segmented button above the charts) switches the default visibility in three modes:

| Mode         | Shown curves                        |
|--------------|-------------------------------------|
| **Merged**   | Fusion curve only — *default*       |
| **Per worker** | One curve per worker (no fusion)  |
| **All**      | Fusion + every worker               |

Switching mode resets the per-chart checkboxes, but a manual checkbox always wins over the mode (per-series override). The canvases are observed (`ResizeObserver`) and re-drawn on resize, so the curves render correctly without a manual window resize.
