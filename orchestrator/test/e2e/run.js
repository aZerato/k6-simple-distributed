// E2E smoke tests for the orchestrator API (worker selection + start/stop).
//
// Usage:
//   node run.js [ORCHESTRATOR_URL]
//   (default: http://localhost:3000, or $ORCHESTRATOR_URL)
//
// It needs the orchestrator running and, for the "real" start cases, at
// least one AVAILABLE worker. The error cases (empty / unknown selection)
// always run. Only one test runs at a time, so each successful start is
// stopped right away and we wait until the workers are idle again.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const base = (process.argv[2] || process.env.ORCHESTRATOR_URL || 'http://localhost:3000').replace(/\/+$/, '');

const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

// The orchestrator reads `scriptPath` on its own machine: resolve a relative
// path (relative to this folder) to an absolute one so the fixtures stay portable.
function resolveScript(payload) {
  if (typeof payload.scriptPath === 'string' && !path.isAbsolute(payload.scriptPath)) {
    payload.scriptPath = path.resolve(dir, payload.scriptPath);
  }
  return payload;
}

async function start(payload) {
  const res = await fetch(`${base}/api/test/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON body */ }
  return { res, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function availableWorkers() {
  try {
    const arr = await (await fetch(`${base}/api/workers`)).json();
    return arr.filter((w) => w.status === 'AVAILABLE');
  } catch {
    return [];
  }
}

// Wait until no worker is BUSY anymore (i.e. the session is fully closed).
async function waitIdle(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ws = [];
    try { ws = await (await fetch(`${base}/api/workers`)).json(); } catch { /* retry */ }
    if (!ws.some((w) => w.status === 'BUSY')) return;
    await sleep(300);
  }
}

const cases = [
  { file: 't_empty.json',    expect: 422, real: false }, // empty selection
  { file: 't_unknown.json',  expect: 400, real: false }, // unknown worker
  { file: 't_all.json',      expect: 200, real: true },  // pasted script, all workers
  { file: 't_all_real.json', expect: 200, real: true },  // .js file, all workers
];

let failures = 0;

async function main() {
  const avail = await availableWorkers();

  for (const c of cases) {
    if (c.real && avail.length === 0) {
      console.log(`SKIP  ${c.file} — no AVAILABLE worker (start cases need 1+)`);
      continue;
    }
    const { res, body } = await start(resolveScript(read(c.file)));
    const ok = res.status === c.expect;
    const detail = ok ? '' : `  <- ${JSON.stringify(body)}`;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.file} -> HTTP ${res.status} (expected ${c.expect})${detail}`);
    if (!ok) failures++;
    if (c.real) {
      // Free the slot before the next case (one test at a time).
      await fetch(`${base}/api/test/stop`, { method: 'POST' });
      await waitIdle();
    }
  }

  console.log(failures === 0 ? 'All E2E checks passed.' : `${failures} E2E check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(`E2E run error: ${e.message} (is the orchestrator up at ${base}?)`);
  process.exitCode = 1;
});
