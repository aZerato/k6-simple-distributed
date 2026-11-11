# Worker Code Structure

Unlike the orchestrator, the worker is **one file** (`worker/worker.js`,
~220 lines): a standalone Node.js agent that keeps a persistent WebSocket
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
| Configuration (env)         | `ORCHESTRATOR_URL`, `WORKER_ID`, `PORT` + per-worker tmp paths  |
| `GET /health`               | HTTP endpoint: `{ workerId, status, k6Running }`               |
| Socket bootstrap            | `socket.io-client` connect (auth `{ workerId }`), infinite reconnection (2 s), `worker:ready` on connect |
| `orchestrator:start_test`   | Validation → tmp script file → env → `spawn(k6, …, { shell: false })` |
| Log streaming               | `worker:log` per k6 stdout/stderr chunk                        |
| Metrics drain (500 ms)      | Re-reads `--out json=<tmpfile>` from the last offset, batches `worker:metrics` |
| Process close               | Final drain, tmp files cleanup, `worker:test_finished`, back to AVAILABLE |
| `orchestrator:stop_test`    | `SIGINT` to the k6 process                                     |
| `SIGTERM` handler           | Kill k6 (`SIGKILL`), close HTTP server, exit                   |

## Configuration (env vars)

| Variable           | Default               | Role                                                    |
|--------------------|-----------------------|---------------------------------------------------------|
| `ORCHESTRATOR_URL` | `http://localhost:3000` | Orchestrator's base URL (WebSocket channel)          |
| `WORKER_ID`        | `worker-<random7>`    | Identity: socket auth (`{ workerId }`) + tmp file names |
| `PORT`             | `4000`                | Local HTTP server port (`/health`)                    |

## Socket protocol

**Inbound** (orchestrator → worker):

| Event                   | Payload                                    | Worker action                       |
|-------------------------|--------------------------------------------|-------------------------------------|
| `orchestrator:start_test` | `{ scriptContent, vus, duration, envVariables }` | Writes the tmp script, spawns k6 (refused if busy) |
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
* **Sanitized arguments:** `vus` is force-cast with `parseInt` (fallback `1`),
  `duration` must match `/^[0-9]+[smh]$/` (fallback `10s`).
* **Sandboxed script:** the received script is written as-is to a per-worker
  tmp file; k6 is the JS sandbox (no access to the host's Node.js APIs).
* `K6_NO_USAGE_REPORT=true` disables k6's telemetry.
* One test at a time: a `start_test` while BUSY answers `worker:error`.

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
