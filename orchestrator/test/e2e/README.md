# E2E smoke tests (orchestrator API)

Ready-to-run fixtures that exercise `POST /api/test/start` end to end — no
temp files to recreate. They cover **worker selection** (see
`docs/architecture.md` §2.1), the two script sources (`scriptContent`
pasted / `scriptPath` file), and the **load profile** (a k6 v2 `scenarios`
map passed as `scenarioOptions`, split over the workers and sent to each
as the `K6_SCENARIO_OPTIONS` env var).

| File                | Sends                                                    | Expected             |
|---------------------|----------------------------------------------------------|----------------------|
| `t_empty.json`      | valid profile + `workerIds: []` (empty selection)        | `422`               |
| `t_unknown.json`    | valid profile + `workerIds: ["nope-123"]` (unknown worker) | `400`             |
| `t_bad_profile.json`| unknown executor (invalid `scenarioOptions`)             | `400`               |
| `t_all.json`        | pasted `scriptContent`, no selection → all available (constant-vus) | `200` (test starts) |
| `t_all_real.json`   | `scriptPath: e2e_script.js`, no selection → all available (constant-vus) | `200` (test starts) |
| `t_ramping.json`    | ramping-vus `scenarioOptions`, no selection              | `200` (test starts) |
| `e2e_script.js`     | the k6 script read by `t_all_real.json` (hits `k6.io`); declares `options.scenarios = JSON.parse(__ENV.K6_SCENARIO_OPTIONS)` | — |

`e2e_script.js` is a real (tiny) k6 script: it does `http.get('https://k6.io')`
and a `status is 200` check, so a successful run is a genuine end-to-end pass
(a worker really ran k6 and the metrics came back).

## Run

```shell
node orchestrator/test/e2e/run.js [ORCHESTRATOR_URL]
# default: http://localhost:3000 (or $ORCHESTRATOR_URL)
```

The runner needs the orchestrator up; the two "real" start cases additionally
need at least one **AVAILABLE** worker (they are skipped otherwise, the error
cases always run). Because only one test runs at a time, each successful start
is stopped right away and the runner waits until the workers are idle again.

`run.js` resolves the relative `scriptPath` of `t_all_real.json` to an
absolute one, so the fixtures stay portable (no machine-specific path).

## Rule

These fixtures **must be run** (at least the error cases, plus the start cases
when a worker is available) and **kept up to date**: whenever
`POST /api/test/start` changes (a new field, a new status code, a new
selection/validation rule), update the matching `t_*.json` / `e2e_script.js`
and the expected code in `run.js` in the same change — the E2E fixtures must
always mirror the current API.
