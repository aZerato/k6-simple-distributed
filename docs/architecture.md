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
2. **Test order (`orchestrator:start_test`):** The orchestrator sends each **targeted worker** a JSON payload `{ scriptContent, vus, duration, envVariables }` — the total VUS are distributed **only across the targeted workers** (see §2.1).
3. **Secure execution:** The worker writes the JS script into an ephemeral file, sanitizes the arguments, and launches k6 in isolation (`{ shell: false }`), then announces `worker:status_changed` (`BUSY`). A refusal (already busy, missing script) is answered with `worker:error`.
4. **Real-time upload (`worker:log`):** Every `stdout`/`stderr` chunk produced by k6 is pushed over the WebSocket to the orchestrator for live display.
5. **Raw metrics (`worker:metrics`):** In parallel, k6 writes its data points to an ephemeral file (`--out json=`), which the worker re-reads line by line and batches to the orchestrator (see §5).
6. **Emergency stop (`orchestrator:stop_test`):** The orchestrator can interrupt the test at any time; the worker sends `SIGINT` to the k6 process.
7. **End of test (`worker:test_finished`):** Once the k6 process exits, the worker sends back `{ exitCode }`, cleans up its ephemeral files, and goes back to the "Available" state (`worker:status_changed`).

#### 2.1 Targeted execution (worker selection)

`POST /api/test/start` accepts an optional `workerIds`:

* **absent / empty** → every **available** worker (backward compatible);
* unknown worker → `400`, worker not available → `422`, empty selection → `422`.

The VUS are fairly distributed **only across the targeted workers** (the
first one receives the remainder of the division); a worker that would
receive 0 VU is simply not targeted, and if no worker can be targeted the
request answers `422`. The response carries the selection back
(`workersCibles` + `workerIds`). In the web console, each worker has a
checkbox (default: all) with *All / None* shortcuts, and "Start" is
disabled when none is selected.

---

## 3. Execution Hardening (Against code injection)

To forbid the execution of malicious system commands (e.g. `rm -rf /` or `curl http://malicious...`), the worker's Express/Node.js code applies the following strict rules:

* **No intermediate Shell:** The k6 process is instantiated via `child_process.spawn('k6', [...])` with the `{ shell: false }` option. This prevents the injection of command operators such as `;`, `&&`, or `|`.
* **Argument sanitization:** The arguments passed to k6 (such as the duration or the number of VUs) are explicitly cast (e.g. `parseInt()`) or validated by a strict Regex before being injected into the command.
* **Ephemeral JS file:** The received JavaScript script is written as-is into a directory dedicated to k6. k6 acting as a JavaScript sandbox (with no access to the host system's native Node.js APIs such as `fs` or `child_process`), the script cannot compromise the worker's machine.

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
