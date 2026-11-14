import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';
import readline from 'node:readline/promises';
import { scenarioDurationSeconds } from '../orchestrator/profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { io: connectSocket } = createRequire(path.join(ROOT, 'orchestrator', 'package.json'))('socket.io-client');

const base = (process.env.ORCHESTRATOR_URL || 'http://localhost:3000').replace(/\/+$/, '');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const idIdx = argv.indexOf('--id');
const presetId = idIdx >= 0 ? argv[idIdx + 1] : null;
const scenIdx = argv.indexOf('--scenarios');
let SCENARIOS_FILE = path.join(ROOT, 'orchestrator', 'test', 'scenarios.tests.json');
if (scenIdx >= 0) {
  const p = argv[scenIdx + 1];
  if (!p || p.startsWith('--')) {
    console.error('Missing path after "--scenarios".');
    process.exit(1);
  }
  SCENARIOS_FILE = path.resolve(p);
}
const reportsDirIdx = argv.indexOf('--reportsDir');
let REPORTS_DIR = path.join(ROOT, 'tmp');
if (reportsDirIdx >= 0) {
  const p = argv[reportsDirIdx + 1];
  if (!p || p.startsWith('--')) {
    console.error('Missing path after "--reportsDir".');
    process.exit(1);
  }
  REPORTS_DIR = path.resolve(p);
}

function nomFromScript(name) {
  return path.basename(name).split('.')[0].replace(/[^\w-]+/g, '_');
}
function timestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function getJson(url) { return (await fetch(url)).json(); }

let followSessionId = null;
function connectLogSocket() {
  const socket = connectSocket(base);
  let warned = false;
  socket.on('ui:log', (e) => {
    if (e.session !== followSessionId) return;
    console.log(`  [worker ${e.workerId}${e.type === 'stderr' ? ' | STDERR' : ''}] ${e.text}`);
  });
  socket.on('connect_error', (err) => {
    if (!warned) { warned = true; console.warn(`Live worker logs unavailable (${err.message}).`); }
  });
  return socket;
}

function buildRequest(scenario) {
  const scriptRel = scenario.script;
  const scriptAbs = path.isAbsolute(scriptRel) ? scriptRel : path.join(ROOT, scriptRel);
  const scriptContent = fs.readFileSync(scriptAbs, 'utf8');

  const env = scenario.env || {};
  const envVariables = {}, attachments = {};
  for (const [key, value] of Object.entries(env)) {
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

  const opts = scenario.options || {};
  const scenarioOptions = opts.executor ? { default: opts } : opts;

  return {
    scriptContent, scenarioOptions, envVariables, attachments,
    _meta: { scriptRel, scriptAbs, scenarioOptions }
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
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Timed out waiting for the test to finish (${(timeoutMs / 1000).toFixed(0)}s).`);
}

function buildManifest(scenario, req, start, report, folderName) {
  const sess = report.session || {};
  const codes = (report.workers || []).map((w) => `${w.id}=${w.exitCode}`).join(', ');
  const checksPct = report.totals && report.totals.checksPct != null ? report.totals.checksPct.toFixed(1) + ' %' : '—';
  const profileLabel = Object.entries(req.scenarioOptions)
    .map(([n, sc]) => `${n} (${sc.executor})`).join(', ');
  return `# Manifest — scenario ${scenario.id} 

**Scenario:** ${scenario.scenario}
**Script:** \`${scenario.name}\` (resolved: \`${req._meta.scriptAbs}\`)
**Folder:** \`${folderName}\`

## Test parameters
- **Scenarios:** \`${profileLabel}\`
- **Env (\`__ENV\`):** \`${JSON.stringify(req.envVariables)}\`
- **Data files (uploaded):** ${Object.keys(req.attachments).length ? Object.keys(req.attachments).map((n) => `\`${n}\``).join(', ') : 'none'}
- **Targeted workers:** ${start.workerIds ? start.workerIds.join(', ') : '(default: every available worker)'}

## Load profile (sent to the API as JSON)
\`\`\`json
${JSON.stringify(req.scenarioOptions, null, 2)}
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
  if (!fs.existsSync(SCENARIOS_FILE)) {
    console.error(`No scenarios file at: ${SCENARIOS_FILE}`);
    process.exitCode = 1;
    return;
  }
  const scenarios = JSON.parse(fs.readFileSync(SCENARIOS_FILE, 'utf8'));

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

  let req;
  try { req = buildRequest(scenario); } catch (e) { console.error(`Cannot build the request: ${e.message}`); process.exitCode = 1; return; }

  if (dryRun) {
    console.log('--- DRY RUN (no POST) ---');
    console.log(`script     : ${req._meta.scriptRel}`);
    console.log(`profile    : ${JSON.stringify(req.scenarioOptions)}`);
    console.log(`env        : ${JSON.stringify(req.envVariables)}`);
    console.log(`attachments: ${Object.keys(req.attachments).join(', ') || '(none)'}`);
    console.log('--- script (as-is, no options injection) ---');
    console.log(req.scriptContent);
    return;
  }

  const logSocket = connectLogSocket();
  const res = await fetch(`${base}/api/test/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scriptContent: req.scriptContent,
      scenarioOptions: req.scenarioOptions,
      envVariables: req.envVariables,
      attachments: req.attachments
    })
  });
  const start = await res.json().catch(() => ({}));
  if (!res.ok || !start.sessionId) {
    logSocket.disconnect();
    console.error(`Start failed (HTTP ${res.status}): ${start.error || JSON.stringify(start)}`);
    process.exitCode = 1;
    return;
  }
  followSessionId = start.sessionId;
  const startedAt = new Date();
  console.log(`Test started — session ${start.sessionId} — workers: ${start.workerIds.join(', ')}`);
  console.log('Live worker logs (k6 stdout/stderr, relayed by the orchestrator):');

  const expectedSecs = Object.values(req.scenarioOptions).reduce((a, sc) => Math.max(a, scenarioDurationSeconds(sc)), 0);
  await waitForFinish(start.sessionId, (expectedSecs * 1.5 + 60) * 1000);
  logSocket.disconnect();

  const reportRes = await fetch(`${base}/api/test/report?session=${start.sessionId}`);
  if (!reportRes.ok) { console.error(`Cannot fetch the report (HTTP ${reportRes.status}).`); process.exitCode = 1; return; }
  const reportText = await reportRes.text();
  const report = JSON.parse(reportText);

  const htmlRes = await fetch(`${base}/api/test/report?session=${start.sessionId}&format=html`);
  if (!htmlRes.ok) { console.error(`Cannot fetch the HTML report (HTTP ${htmlRes.status}).`); process.exitCode = 1; return; }
  const htmlText = await htmlRes.text();

  const folderName = `${scenario.id}_${nomFromScript(scenario.name)}_${timestamp()}`;
  const folder = path.join(REPORTS_DIR, folderName);
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
