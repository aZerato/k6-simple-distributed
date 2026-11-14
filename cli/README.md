# cli/

`scenario-runner.js` launches a named k6 scenario end to end through the
orchestrator API: it reads the scenarios file passed with the required
`--scenarios <path>` parameter, wraps the
scenario's `options` (a single k6 v2 scenario definition) under the `default`
name into the `scenarios` map the API expects (`scenarioOptions`), uploads the
`env` data files, streams every selected worker's live k6 logs on the console,
waits for the test to finish, and archives `report.json` + `report.html` +
`manifest.md` in the archive directory (default: `<root>/tmp/`, override with
`--reportsDir <path>`) under `<id>_<name>_<timestamp>/`.

## Usage

```console
node cli/scenario-runner.js --scenarios ./my-scenarios.json              # interactive (prompt for an id)
node cli/scenario-runner.js --id 2 --scenarios ./my-scenarios.json       # non-interactive
node cli/scenario-runner.js --id 2 --dry-run --scenarios ./my-scenarios.json # print the request, no POST
node cli/scenario-runner.js --id 2 --reportsDir ./reports --scenarios ./my-scenarios.json
ORCHESTRATOR_URL=http://host:3000 node cli/scenario-runner.js --scenarios ./my-scenarios.json
```

`--scenarios <path>` is **required** (no fallback). Both path parameters are
taken relative to the current working directory; `--reportsDir` is optional
and falls back to `<root>/tmp/` (a missing directory is created).

## The files in `orchestrator/test/` it works with

| File | Role |
| --- | --- |
| `scenarios.tests.json` | the list of scenarios (id, name, script, scenario, options, env) — pass it with the required `--scenarios <path>` |
| `basic.test.js`, `csv.test.js` | the k6 scripts the scenarios target |
| `data.csv`, `data2.csv` | the data files listed in `env` (uploaded to the workers, name passed as an `__ENV` var) |

Example — scenario `2` from `scenarios.tests.json`:

```json
{
  "id": "2",
  "name": "basic test",
  "script": "./orchestrator/test/basic.test.js",
  "scenario": "Description of the scenario 2",
  "options": { "executor": "constant-vus", "vus": 50, "duration": "50s" }
}
```

is launched with:

```console
node cli/scenario-runner.js --id 2 --scenarios orchestrator/test/scenarios.tests.json
```

## Note

`socket.io-client` (used to stream the workers' live logs) is installed with
the orchestrator — `orchestrator/package.json`; the runner loads it from
`orchestrator/node_modules` (there is no root `package.json`).
