// Scenario runner — launches a k6 scenario from scenarios.tests.json through the
// orchestrator API, waits for it to finish, retrieves the reports, and archives
// (report.json + report.html + manifest.md) under <project root>/tmp/<id>_<name>_<timestamp>/.
//
// The scenario `options` (the load profile) is passed as JSON to the API,
// because k6 v2 ignores the script's `options` (the profile is CLI-driven):
// constant-vus -> totalVus/duration, ramping-vus -> startVUs/stages. The
// `env` field is mapped to k6 `__ENV` vars; values that are paths to real
// files are also uploaded as data files (basename) so the script can
// `open()` them like a local run.
//
// Usage:
//   node orchestrator/test/scenario-runner.js                 # interactive (prompt for an id)
//   node orchestrator/test/scenario-runner.js --id 2          # non-interactive
//   node orchestrator/test/scenario-runner.js --id 2 --dry-run# print the request, no POST
//   ORCHESTRATOR_URL=http://host:3000 node orchestrator/test/scenario-runner.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'node:readline/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');          // project root
const SCENARIOS_FILE = path.join(__dirname, 'scenarios.tests.json');
const TMP_DIR = path.join(ROOT, 'tmp');
const base = (process.env.ORCHESTRATOR_URL || 'http://localhost:3000').replace(/\/+$/, '');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const idIdx = argv.indexOf('--id');
const presetId = idIdx >= 0 ? argv[idIdx + 1] : null;

// --- small helpers ---
function parseDurationToSeconds(d) {
  const m = typeof d === 'string' && /^([0-9]+)([smh])$/.exec(d);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}
function formatSecondsToK6(s) {
  if (s >= 60 && s % 60 === 0) return `${s / 60}m`;
  return `${Math.ceil(s)}s`;
}
function nomFromScript(name) {
  return path.basename(name).split('.')[0].replace(/[^\w-]+/g, '_');
}
function timestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function getJson(url) { return (await fetch(url)).json(); }

// Build the /api/test/start request from a scenario.
// The load profile is passed as JSON (k6 v2 ignores the script's `options`):
//   - constant-vus -> totalVus + duration
//   - ramping-vus  -> startVUs + stages
// The `env` field becomes k6 `__ENV` variables; values that are real files on
// disk are also uploaded as data files (basename) so the script can `open()`
// them like a local run.
function buildRequest(scenario) {
  const scriptRel = scenario.name;
  const scriptAbs = path.isAbsolute(scriptRel) ? scriptRel : path.join(ROOT, scriptRel);
  const scriptContent = fs.readFileSync(scriptAbs, 'utf8');

  // env -> `__ENV` variables; a value that is a real file on disk is uploaded
  // (basename) AND passed as the env var name.
  const envVariables = {}, attachments = {};
  for (const [key, value] of Object.entries(scenario.env || {})) {
    const v = String(value);
    const abs = path.isAbsolute(v) ? v : path.join(ROOT, v);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const name = path.basename(abs);
      attachments[name] = fs.readFileSync(abs).toString('base64');
      envVariables[key] = name;
    } else {
      envVariables[key] = v;
    }
  }

  // The load profile as JSON, straight from the scenario `options`.
  const o = scenario.options || {};
  const profile = o.executor === 'constant-vus'
    ? { totalVus: o.vus, duration: o.duration }
    : { startVUs: o.startVUs || 0, stages: o.stages || [] };

  return {
    scriptContent, ...profile, envVariables, attachments,
    _meta: { scriptRel, scriptAbs, executor: o.executor || 'constant-vus', profile }
  };
}

function printScenarios(scenarios) {
  console.log('Available scenarios:');
  for (const s of scenarios) {
    console.log(`  [${s.id}]  ${s.name}\n       ${s.scenario}`);
  }
}

async function waitForFinish(sessionId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const arr = await getJson(`${base}/api/test/sessions`).catch(() => []);
    const s = arr.find((x) => x.id === sessionId);
    if (s && s.status === 'FINISHED') {
      console.log(`Finished: ${s.overall}`);
      return s;
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Timed out waiting for the test to finish (${(timeoutMs / 1000).toFixed(0)}s).`);
}

function buildManifest(scenario, req, start, report, folderName) {
  const sess = report.session || {};
  const codes = (report.workers || []).map((w) => `${w.id}=${w.exitCode}`).join(', ');
  const checksPct = report.totals && report.totals.checksPct != null ? report.totals.checksPct.toFixed(1) + ' %' : '—';
  const profileLabel = req._meta.executor === 'constant-vus'
    ? `constant-vus (${req.totalVus} VUs, ${req.duration})`
    : `ramping-vus (start ${req.startVUs} VUs, ${req.stages.length} stage(s))`;
  return `# Manifest — scenario ${scenario.id}

**Scenario:** ${scenario.scenario}
**Script:** \`${scenario.name}\` (resolved: \`${req._meta.scriptAbs}\`)
**Folder:** \`${folderName}\`

## Test parameters
- **Executor:** \`${req._meta.executor}\`
- **Profile (sent):** \`${profileLabel}\`
- **Env (\`__ENV\`):** \`${JSON.stringify(req.envVariables)}\`
- **Data files (uploaded):** ${Object.keys(req.attachments).length ? Object.keys(req.attachments).map((n) => `\`${n}\``).join(', ') : 'none'}
- **Targeted workers:** ${start.workerIds ? start.workerIds.join(', ') : '(default: every available worker)'}

## Load profile (sent to the API as JSON)
\`\`\`json
${JSON.stringify(req._meta.profile, null, 2)}
\`\`\`

## Execution
- **Session:** \`${start.sessionId}\`
- **Started at:** ${sess.createdAt || start.startedAt.toISOString()}
- **Finished at:** ${sess.finishedAt || '—'}
- **Overall status:** ${sess.overall || '—'}
- **Exit codes:** ${codes || '—'}
- **HTTP requests:** ${report.totals ? report.totals.httpReqs : '—'}
- **Checks:** ${checksPct}

## Report
\`report.json\` — full JSON report of the orchestrator for this session.
\`report.html\` — self-contained HTML report (open it in a browser).
`;
}

async function main() {
  const scenarios = JSON.parse(fs.readFileSync(SCENARIOS_FILE, 'utf8'));

  // --- pick the scenario ---
  let scenario;
  if (presetId != null) {
    scenario = scenarios.find((s) => String(s.id) === String(presetId));
    if (!scenario) { console.error(`No scenario with id "${presetId}".`); process.exitCode = 1; return; }
  } else {
    printScenarios(scenarios);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let ans;
    try { ans = (await rl.question('Pick an id (or "q" to quit): ')).trim(); } finally { rl.close(); }
    if (!ans || ans.toLowerCase() === 'q') { console.log('Cancelled.'); return; }
    scenario = scenarios.find((s) => String(s.id) === ans);
    if (!scenario) { console.log(`No scenario with id "${ans}".`); process.exitCode = 1; return; }
  }

  // --- build the request ---
  let req;
  try { req = buildRequest(scenario); } catch (e) { console.error(`Cannot build the request: ${e.message}`); process.exitCode = 1; return; }

  if (dryRun) {
    console.log('--- DRY RUN (no POST) ---');
    console.log(`script     : ${req._meta.scriptRel}`);
    console.log(`profile    : ${JSON.stringify(req._meta.profile)}`);
    console.log(`env        : ${JSON.stringify(req.envVariables)}`);
    console.log(`attachments: ${Object.keys(req.attachments).join(', ') || '(none)'}`);
    console.log('--- script (as-is, no options injection) ---');
    console.log(req.scriptContent);
    return;
  }

  // --- start ---
  const res = await fetch(`${base}/api/test/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scriptContent: req.scriptContent,
      ...(req._meta.executor === 'constant-vus'
        ? { totalVus: req.totalVus, duration: req.duration }
        : { startVUs: req.startVUs, stages: req.stages }),
      envVariables: req.envVariables,
      attachments: req.attachments
    })
  });
  const start = await res.json().catch(() => ({}));
  if (!res.ok || !start.sessionId) {
    console.error(`Start failed (HTTP ${res.status}): ${start.error || JSON.stringify(start)}`);
    process.exitCode = 1;
    return;
  }
  const startedAt = new Date();
  console.log(`Test started — session ${start.sessionId} — workers: ${start.workerIds.join(', ')}`);

  // --- wait for completion ---
  const expectedSecs = scenario.options && scenario.options.executor === 'constant-vus'
    ? parseDurationToSeconds(scenario.options.duration)
    : (scenario.options.stages || []).reduce((a, s) => a + parseDurationToSeconds(s.duration), 0);
  await waitForFinish(start.sessionId, (expectedSecs * 1.5 + 60) * 1000);

  // --- retrieve the report ---
  const reportRes = await fetch(`${base}/api/test/report?session=${start.sessionId}`);
  if (!reportRes.ok) { console.error(`Cannot fetch the report (HTTP ${reportRes.status}).`); process.exitCode = 1; return; }
  const reportText = await reportRes.text();
  const report = JSON.parse(reportText);

  // Self-contained HTML report (same endpoint, format=html)
  const htmlRes = await fetch(`${base}/api/test/report?session=${start.sessionId}&format=html`);
  if (!htmlRes.ok) { console.error(`Cannot fetch the HTML report (HTTP ${htmlRes.status}).`); process.exitCode = 1; return; }
  const htmlText = await htmlRes.text();

  // --- archive: folder + report.json + report.html + manifest.md ---
  const folderName = `${scenario.id}_${nomFromScript(scenario.name)}_${timestamp()}`;
  const folder = path.join(TMP_DIR, folderName);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'report.json'), reportText);
  fs.writeFileSync(path.join(folder, 'report.html'), htmlText);
  fs.writeFileSync(path.join(folder, 'manifest.md'), buildManifest(scenario, req, { ...start, startedAt }, report, folderName));

  console.log(`\nReport archived in: ${folder}`);
  console.log(`  report.json   (${(reportText.length / 1024).toFixed(1)} KiB)`);
  console.log(`  report.html   (${(htmlText.length / 1024).toFixed(1)} KiB)`);
  console.log(`  manifest.md`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
