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
2. **Test order (`orchestrator:start_test`):** The orchestrator sends each **targeted worker** a JSON payload `{ scriptContent, envVariables, attachments }`. The **load profile** is not a top-level field: it rides inside `envVariables` as the `K6_SCENARIO_OPTIONS` variable — a JSON string carrying that worker's share of the k6 v2 `scenarios` map (see §2.1) — which the script reads with `options.scenarios = JSON.parse(__ENV.K6_SCENARIO_OPTIONS)`. `attachments` carries the uploaded data files (see §2.2).
3. **Secure execution:** The worker creates a **per-test working directory** — `test-<timestamp>-<pid>/` inside its ephemeral files directory (`WORKER_TMP_DIR` env var, default: the OS temp dir; the `<pid>` suffix keeps two worker instances from sharing a directory on same-millisecond starts) — and writes the JS script, the uploaded data files, when any, and the raw metrics output there (next to each other, so relative paths in the script resolve like a local run), sanitizes the arguments, and launches k6 in isolation (`{ shell: false }`), then announces `worker:status_changed` (`BUSY`). The whole directory is deleted at the end of the test. A refusal (already busy, missing script, invalid data file) is answered with `worker:error`.
4. **Real-time upload (`worker:log`):** Every `stdout`/`stderr` chunk produced by k6 is pushed over the WebSocket to the orchestrator for live display.
5. **Raw metrics (`worker:metrics`):** In parallel, k6 writes its data points to an ephemeral file (`--out json=`), which the worker re-reads line by line and batches to the orchestrator (see §5).
6. **Emergency stop (`orchestrator:stop_test`):** The orchestrator can interrupt the test at any time; the worker sends `SIGINT` to the k6 process.
7. **End of test (`worker:test_finished`):** Once the k6 process exits — or fails to even start (binary missing: Node emits `error`, never `close`, so the worker closes the test itself with exit code `-1`) — the worker sends back `{ exitCode }`, cleans up its ephemeral files, and goes back to the "Available" state (`worker:status_changed`).

#### 2.1 Targeted execution (worker selection)

`POST /api/test/start` accepts an optional `workerIds`:

* **absent / empty** → every **available** worker (backward compatible);
* unknown worker → `400`, worker not available → `422`, empty selection → `422`.

The **load profile** — a k6 v2 `scenarios` map (`scenarioOptions` in the
request body) — is fairly split **only across the targeted workers**: every
numeric field of each scenario (`vus`, `startVUs`, the `target` of every
stage, `iterations`, `rate`, `preAllocatedVUs`, `maxVUs`) is divided over the
workers, the first one receiving the remainder of each division, so the
shares always sum back to the original value (see `orchestrator/profile.js`).
Each worker gets its split `scenarios` map serialized as the
`K6_SCENARIO_OPTIONS` env var. A worker that would receive 0 VU at its peak
is simply not targeted, and if no worker can be targeted the request answers
`422`. The response carries the selection back
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
runner sends the scenario's `options` — a single k6 v2 scenario definition (the
load profile) — wrapped under the `default` name into the `scenarios` map the
API expects (`scenarioOptions`); the API splits it over the workers and each
script reads its share with
`options.scenarios = JSON.parse(__ENV.K6_SCENARIO_OPTIONS)` (see §4).
While the test runs, the runner also joins the orchestrator's dashboard socket
room (the plain web-console profile, no `workerId`) and prints each selected
worker's k6 stdout/stderr live on the console, line by line.

---

## 3. Execution Hardening (Against code injection)

To forbid the execution of malicious system commands (e.g. `rm -rf /` or `curl http://malicious...`), the worker's Express/Node.js code applies the following strict rules:

* **No intermediate Shell:** The k6 process is instantiated via `child_process.spawn('k6', [...])` with the `{ shell: false }` option. This prevents the injection of command operators such as `;`, `&&`, or `|`.
* **Argument sanitization:** The only arguments the worker ever passes to k6 are the fixed `run`, `--out json=<file>` and the script path (all internal, no user input); the load profile is not a CLI argument — it rides in the `K6_SCENARIO_OPTIONS` env var (see §4), and the script's `__ENV` values are strings k6 hands to the JS sandbox, never shell-evaluated.
* **Ephemeral JS file:** The received JavaScript script is written as-is into the worker's per-test working directory (`WORKER_TMP_DIR`, default: the OS temp dir). k6 acting as a JavaScript sandbox (with no access to the host system's native Node.js APIs such as `fs` or `child_process`), the script cannot compromise the worker's machine.

---

## 4. Technical Specification of the Node.js Worker

Each agent ships a lightweight Node.js application combining **Express** (for health checks) and **Socket.io-client** (for the command channel).

### Conceptual example of the execution in the Worker:

```javascript
// The load profile is NOT built as a CLI argument: it arrives in
// `payload.envVariables.K6_SCENARIO_OPTIONS` (a JSON string — this worker's
// share of the `scenarios` map), which the script reads with
// `options.scenarios = JSON.parse(__ENV.K6_SCENARIO_OPTIONS)`.

// Secure writing of the received k6 script
fs.writeFileSync('/tmp/test_load.js', payload.scriptContent);

// Secure launch (no shell, arguments encapsulated in an array).
// Only fixed, internal flags — the profile flows through `__ENV`, never the CLI.
const k6Env = { ...process.env, ...payload.envVariables }; // K6_SCENARIO_OPTIONS in there
const k6Process = spawn('k6', [
  'run',
  '--out', 'json=/tmp/metrics.json', // raw data points, re-read and streamed
  '/tmp/test_load.js'
], { shell: false, env: k6Env });

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

> **k6 v2:** the load profile is the script's `options.scenarios` map. The
> worker sends **no** profile CLI argument (a CLI `--vus`/`--stage` would
> override the script's `scenarios` entirely); instead it sets the
> `K6_SCENARIO_OPTIONS` env var — the worker's split share of the `scenarios`
> map, as a JSON string — and the script consumes it with
> `options.scenarios = JSON.parse(__ENV.K6_SCENARIO_OPTIONS)`.

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
