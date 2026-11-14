// k6 v2 load profile handling.
//
// The profile is a k6 v2 `scenarios` map (the `options.scenarios` of the
// script), e.g.:
//   { "default": { "executor": "constant-vus", "vus": 50, "duration": "30s" } }
//
// It is NOT sent to k6 as CLI arguments (in k6 v2 a CLI profile overrides the
// script's `options.scenarios` entirely). Instead the orchestrator splits the
// numeric fields (VUS / rates / iterations) over the targeted workers and
// sends each worker its share as the `K6_SCENARIO_OPTIONS` `__ENV` variable —
// a JSON string the script reads with:
//   export const options = { scenarios: JSON.parse(__ENV.K6_SCENARIO_OPTIONS) };
//
// Supported executors (k6 v2): constant-vus, ramping-vus, shared-iterations,
// per-vu-iterations, constant-arrival-rate, ramping-arrival-rate.
import { parseDurationSeconds, formatSeconds } from './utils.js';

export const EXECUTORS = [
  'constant-vus',
  'ramping-vus',
  'shared-iterations',
  'per-vu-iterations',
  'constant-arrival-rate',
  'ramping-arrival-rate'
];

// Split an integer `total` over `n` workers: the first worker takes the
// remainder of the division, so the shares always sum back to `total`.
function share(total, index, n) {
  return Math.floor(total / n) + (index === 0 ? total % n : 0);
}

// Per-scenario copy with the numeric fields split for one worker.
function splitScenario(sc, index, n) {
  const c = { ...sc };
  switch (sc.executor) {
    case 'constant-vus':
      c.vus = share(sc.vus, index, n);
      break;
    case 'ramping-vus':
      if (typeof sc.startVUs === 'number') c.startVUs = share(sc.startVUs, index, n);
      c.stages = sc.stages.map((s) => ({ ...s, target: share(s.target, index, n) }));
      break;
    case 'shared-iterations':
      c.vus = share(sc.vus, index, n);
      c.iterations = share(sc.iterations, index, n);
      break;
    case 'per-vu-iterations':
      c.vus = share(sc.vus, index, n);
      break;
    case 'constant-arrival-rate':
      c.rate = share(sc.rate, index, n);
      c.preAllocatedVUs = share(sc.preAllocatedVUs, index, n);
      if (typeof sc.maxVUs === 'number') c.maxVUs = share(sc.maxVUs, index, n);
      break;
    case 'ramping-arrival-rate':
      if (typeof sc.startRate === 'number') c.startRate = share(sc.startRate, index, n);
      c.preAllocatedVUs = share(sc.preAllocatedVUs, index, n);
      if (typeof sc.maxVUs === 'number') c.maxVUs = share(sc.maxVUs, index, n);
      if (Array.isArray(sc.stages)) c.stages = sc.stages.map((s) => ({ ...s, target: share(s.target, index, n) }));
      break;
  }
  return c;
}

// The per-worker share of the profile (a full `scenarios` map).
export function splitScenarios(scenarioOptions, index, workersCount) {
  const out = {};
  for (const [name, sc] of Object.entries(scenarioOptions)) out[name] = splitScenario(sc, index, workersCount);
  return out;
}

// Peak VUS of one scenario (the highest concurrent VUS it reaches).
export function scenarioPeakVus(sc) {
  switch (sc.executor) {
    case 'constant-vus': return sc.vus;
    case 'ramping-vus': return Math.max(...sc.stages.map((s) => s.target));
    case 'shared-iterations':
    case 'per-vu-iterations': return sc.vus;
    case 'constant-arrival-rate':
    case 'ramping-arrival-rate': return sc.maxVUs || sc.preAllocatedVUs;
    default: return 0;
  }
}

// Duration of one scenario, in seconds (scenarios run concurrently, so the
// session duration is the max across scenarios, computed by the caller).
export function scenarioDurationSeconds(sc) {
  switch (sc.executor) {
    case 'constant-vus':
    case 'constant-arrival-rate':
      return parseDurationSeconds(sc.duration);
    case 'ramping-vus':
    case 'ramping-arrival-rate':
      return sc.stages.reduce((a, s) => a + parseDurationSeconds(s.duration), 0);
    case 'shared-iterations':
    case 'per-vu-iterations':
      return parseDurationSeconds(sc.maxDuration || '10m');
    default:
      return 0;
  }
}

// Session-level totals of the (unsplit) profile:
//   - peak VUS: the scenarios run concurrently, so the peak is the SUM of
//     every scenario's peak;
//   - duration: the test ends when the last scenario ends (max).
export function scenarioTotals(scenarioOptions) {
  let totalVus = 0;
  let durationSeconds = 0;
  for (const sc of Object.values(scenarioOptions)) {
    totalVus += scenarioPeakVus(sc);
    durationSeconds = Math.max(durationSeconds, scenarioDurationSeconds(sc));
  }
  return { totalVus, duration: formatSeconds(durationSeconds) };
}

// Validate the profile. Returns an error message, or null when it is valid.
export function validateScenarios(scenarioOptions) {
  if (!scenarioOptions || typeof scenarioOptions !== 'object' || Array.isArray(scenarioOptions)) {
    return 'Missing load profile: "scenarioOptions" must be a JSON object — the k6 v2 `scenarios` map (e.g. { "default": { "executor": "constant-vus", "vus": 1, "duration": "10s" } }).';
  }
  const names = Object.keys(scenarioOptions);
  if (names.length === 0) {
    return 'Empty load profile: "scenarioOptions" must contain at least one scenario.';
  }
  const int = (v) => Number.isInteger(v);
  const dur = (v) => typeof v === 'string' && /^[0-9]+[smh]$/.test(v);
  for (const name of names) {
    const sc = scenarioOptions[name];
    if (!sc || typeof sc !== 'object' || Array.isArray(sc)) {
      return `Invalid scenario "${name}": it must be an object with an "executor" field.`;
    }
    if (!EXECUTORS.includes(sc.executor)) {
      return `Scenario "${name}": unknown executor "${sc.executor}". Supported: ${EXECUTORS.join(', ')}.`;
    }
    switch (sc.executor) {
      case 'constant-vus':
        if (!int(sc.vus) || !dur(sc.duration)) return `Scenario "${name}" (constant-vus): needs an integer "vus" and a "duration" (e.g. "30s").`;
        break;
      case 'ramping-vus':
        if (!Array.isArray(sc.stages) || sc.stages.length === 0) return `Scenario "${name}" (ramping-vus): needs a non-empty "stages" array.`;
        for (const st of sc.stages) if (!dur(st && st.duration) || !int(st && st.target)) return `Scenario "${name}" (ramping-vus): invalid stage ${JSON.stringify(st)} — each stage needs a "duration" (e.g. "2m") and an integer "target".`;
        break;
      case 'shared-iterations':
      case 'per-vu-iterations':
        if (!int(sc.vus) || !int(sc.iterations)) return `Scenario "${name}" (${sc.executor}): needs integer "vus" and "iterations".`;
        break;
      case 'constant-arrival-rate':
        if (!int(sc.rate) || !dur(sc.duration) || !int(sc.preAllocatedVUs)) return `Scenario "${name}" (constant-arrival-rate): needs an integer "rate", a "duration" and an integer "preAllocatedVUs".`;
        break;
      case 'ramping-arrival-rate':
        if (!Array.isArray(sc.stages) || sc.stages.length === 0) return `Scenario "${name}" (ramping-arrival-rate): needs a non-empty "stages" array.`;
        if (!int(sc.preAllocatedVUs)) return `Scenario "${name}" (ramping-arrival-rate): needs an integer "preAllocatedVUs".`;
        for (const st of sc.stages) if (!dur(st && st.duration) || !int(st && st.target)) return `Scenario "${name}" (ramping-arrival-rate): invalid stage ${JSON.stringify(st)} — each stage needs a "duration" and an integer "target" (the rate).`;
        break;
    }
  }
  return null;
}
