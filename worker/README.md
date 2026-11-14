# Worker Code Structure

Unlike the orchestrator, the worker is **one file** (`worker/worker.js`,
~250 lines): a standalone Node.js agent that keeps a persistent WebSocket
link with the orchestrator, runs the official `k6` binary on the received
script, and streams back the console logs and the raw metrics. No routing,
no state machine — the process only speaks the socket protocol.

| File              | Role                                                        |
|-------------------|-------------------------------------------------------------|
| `worker.js`       | Whole agent: socket link, k6 launch, log + metrics streaming |
| `package.json`    | Only two runtime deps: `express`, `socket.io-client`       |

## Sections of `worker.js`

| Section                     | Responsibility                                                    |
|-----------------------------|-----------------------------------------------------------------|
| Configuration (env)         | `ORCHESTRATOR_URL`, `WORKER_ID`, `PORT`, `WORKER_TMP_DIR` (per-test working dirs) |
| `GET /health`               | HTTP endpoint: `{ workerId, status, k6Running }`               |
| Socket bootstrap            | `socket.io-client` connect (auth `{ workerId }`), infinite reconnection (2 s), `worker:ready` on connect |
| `orchestrator:start_test`   | Validation → tmp script file → env → `spawn(k6, …, { shell: false })` |
| Log streaming               | `worker:log` per k6 stdout/stderr chunk                        |
| Metrics drain (500 ms)      | Re-reads `--out json=<tmpfile>` from the last offset, batches `worker:metrics` |
| Process close               | Final drain, tmp files cleanup, `worker:test_finished`, back to AVAILABLE (natural `close` **or** spawn `error`) |
| `orchestrator:stop_test`    | `SIGINT` to the k6 process                                     |
| `SIGTERM` handler           | Kill k6 (`SIGKILL`), close HTTP server, exit                   |

## Configuration (env vars)

| Variable           | Default               | Role                                                    |
|--------------------|-----------------------|---------------------------------------------------------|
| `ORCHESTRATOR_URL` | `http://localhost:3000` | Orchestrator's base URL (WebSocket channel)          |
| `WORKER_ID`        | `worker-<random7>`    | Identity: socket auth (`{ workerId }`)                |
| `PORT`             | `4000`                | Local HTTP server port (`/health`)                    |
| `WORKER_TMP_DIR`  | `os.tmpdir()`         | Working directory for the ephemeral test files; each received test creates `test-<timestamp>-<pid>/` inside it, deleted at test end |

## Socket protocol

**Inbound** (orchestrator → worker):

| Event                   | Payload                                    | Worker action                       |
|-------------------------|--------------------------------------------|-------------------------------------|
| `orchestrator:start_test` | `{ scriptContent, envVariables, attachments }` (the load profile is the `K6_SCENARIO_OPTIONS` entry of `envVariables`, a JSON string — this worker's share of the `scenarios` map) | Writes the tmp script + uploaded data files, spawns k6 with `env` (refused if busy) |
| `orchestrator:stop_test` | —                                       | `SIGINT` to the running k6 process  |

**Outbound** (worker → orchestrator):

| Event                  | Payload                              | Sent                                   |
|------------------------|--------------------------------------|--------------------------------------|
| `worker:ready`         | `{ status }`                        | After (re)connection                 |
| `worker:status_changed`| `{ status: 'BUSY' \| 'AVAILABLE' }` | On test start / end                  |
| `worker:log`           | `{ type: 'stdout' \| 'stderr', output }` | Per k6 console chunk               |
| `worker:metrics`       | `{ data: [ …k6 JSON lines… ] }`     | Per 500 ms drain batch              |
| `worker:test_finished` | `{ exitCode }`                      | When the k6 process exits            |
| `worker:error`         | `{ message }`                       | Refusals (busy, missing script, tmp write) |

## Execution hardening

* **No shell:** `spawn(k6, […], { shell: false })` — command operators
  (`;`, `&&`, `|`) are never evaluated.
* **No profile CLI arguments:** the k6 CLI only ever receives the fixed
  `run`, `--out json=<tmpfile>` and the script path; the load profile rides in
  `envVariables` as the `K6_SCENARIO_OPTIONS` variable (this worker's share of
  the `scenarios` map, JSON string), which the script reads with
  `options.scenarios = JSON.parse(__ENV.K6_SCENARIO_OPTIONS)`.
* **Per-test working directory:** `WORKER_TMP_DIR` (default: `os.tmpdir()`);
  each received test creates `test-<timestamp>-<pid>/` inside it (script +
  data files + `metrics.json`), and the whole directory is deleted at test
  end — the `<pid>` suffix keeps two worker instances from sharing a
  directory.
* **Sandboxed script:** the received script is written as-is into the
  per-test working directory; k6 is the JS sandbox (no access to the host's
  Node.js APIs).
* **Data files (upload):** `attachments` names are sanitized (no path
  separators, no `.` / `..`), written next to the ephemeral script so relative
  paths in the script (`open('./data.csv')`) resolve like a local run, and
  deleted at test end.
* `K6_NO_USAGE_REPORT=true` disables k6's telemetry.
* One test at a time: a `start_test` while BUSY answers `worker:error`.
* **Spawn failure:** if k6 cannot start (binary missing from the PATH…),
  Node emits `error` — never `close` — so the worker closes the test itself:
  final drain, cleanup, `worker:test_finished` (exit code `-1`), back to
  AVAILABLE.

## Metrics pipeline

`k6 run … --out json=<tmpfile>`: every data point (one JSON line per
request/metric) is re-read line by line every 500 ms (offset tracking, last
unfinished line kept), parsed and batched into `worker:metrics` when the
socket is connected. If the orchestrator is unreachable, the buffer is
capped at `MAX_BUFFERED_METRICS` (100 000 lines) — oldest values dropped.

## Requirements

* Node.js + `npm install` (deps: `express`, `socket.io-client`).
* The `k6` binary on the PATH (`k6.exe` on Windows).
* Run: `node worker/worker.js` (env vars as in the root README).
