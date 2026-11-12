# Orchestrator Code Structure

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
| `reports/html.js`| Self-contained HTML report (SVG + embedded JS: checkboxes, tooltip, project footer link) |
| `routes.js`     | HTTP API (controllers): `registerRoutes(app, io)`                   |
| `sockets.js`    | Socket.io channel: `registerSockets(io)` — workers + web console        |

The worker (`worker/worker.js`) is not part of this split: it only speaks
the socket protocol (`worker:ready`, `worker:log`, `worker:metrics`,
`worker:test_finished`, …) and remains a single file.