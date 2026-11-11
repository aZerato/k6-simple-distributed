// Aggregation of k6 metrics (`worker:metrics` stream).
//
// Two aggregation levels per session:
//   - `s.metrics`         : fusion of every worker (main curves);
//   - `s.metricsByWorker` : one aggregate per worker (curves per agent).
// A per-second snapshot (`buildRow`) is broadcast to the console (ui:metrics).
import { RING_CAPACITY, MAX_HISTORY_ROWS, MAX_RAW_LINES_PER_WORKER } from './constants.js';
import { getCurrentSession } from './state.js';

// Circular window: allows recomputing percentiles over the latest values.
class MetricAgg {
  constructor() {
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.last = null;
    this.rateSum = 0;   // accumulated since the last tick (second)
    this.rate = 0;      // value of the last tick
    this.ring = new Float64Array(RING_CAPACITY);
    this.ringLen = 0;
    this.ringIdx = 0;
  }

  ingest(value, count) {
    const weighted = value * count;
    this.count += count;
    this.sum += weighted;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    this.last = value;
    this.rateSum += weighted;
    this.ring[this.ringIdx] = value;
    this.ringIdx = (this.ringIdx + 1) % RING_CAPACITY;
    if (this.ringLen < RING_CAPACITY) this.ringLen++;
  }

  // Copy of the window values, in chronological order
  ringValues() {
    const out = new Array(this.ringLen);
    if (this.ringLen >= RING_CAPACITY) {
      for (let i = 0; i < RING_CAPACITY; i++) out[i] = this.ring[(this.ringIdx + i) % RING_CAPACITY];
    } else {
      for (let i = 0; i < this.ringLen; i++) out[i] = this.ring[i];
    }
    return out;
  }
}

function pctOf(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.min(sorted.length - 1, Math.ceil(idx));
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function aggStats(agg) {
  let p70 = null, p80 = null, p90 = null, p95 = null, p99 = null;
  if (agg.ringLen > 0) {
    const sorted = agg.ringValues().sort((a, b) => a - b);
    p70 = pctOf(sorted, 70);
    p80 = pctOf(sorted, 80);
    p90 = pctOf(sorted, 90);
    p95 = pctOf(sorted, 95);
    p99 = pctOf(sorted, 99);
  }
  return {
    count: agg.count,
    rate: agg.rate,
    avg: agg.count ? agg.sum / agg.count : null,
    min: Number.isFinite(agg.min) ? agg.min : null,
    max: Number.isFinite(agg.max) ? agg.max : null,
    p70, p80, p90, p95, p99
  };
}

// Ingestion of a batch of k6 data points (sent by the worker)
export function ingestMetrics(workerId, items) {
  const s = getCurrentSession();
  if (!s || s.status !== 'RUNNING') return;
  let raw = s.rawMetrics.get(workerId);
  if (!raw) {
    raw = [];
    s.rawMetrics.set(workerId, raw);
  }
  for (const item of items) {
    if (!item || typeof item.metric !== 'string' || !item.data) continue;
    // Raw k6 JSON, line by line (re-downloadable via /api/raw-metrics)
    if (raw.length < MAX_RAW_LINES_PER_WORKER) {
      raw.push(JSON.stringify({ metric: item.metric, data: item.data }));
    } else if (!s.rawTruncated) {
      s.rawTruncated = true;
      console.warn(`[Orchestrator] Raw JSON buffer saturated for ${workerId} (cap ${MAX_RAW_LINES_PER_WORKER} lines).`);
    }
    // k6 metadata lines (no `value`) feed the raw buffer, not the aggregation
    if (typeof item.data.value !== 'number') continue;
    const count = Math.max(1, item.data.count || 1);
    const value = Number(item.data.value) || 0;
    // Global aggregate (fusion of every worker)
    let agg = s.metrics.get(item.metric);
    if (!agg) {
      agg = new MetricAgg();
      s.metrics.set(item.metric, agg);
    }
    agg.ingest(value, count);
    // Per-worker aggregate: feeds the per-agent curves of the console and the report
    let byW = s.metricsByWorker.get(workerId);
    if (!byW) {
      byW = new Map();
      s.metricsByWorker.set(workerId, byW);
    }
    let wagg = byW.get(item.metric);
    if (!wagg) {
      wagg = new MetricAgg();
      byW.set(item.metric, wagg);
    }
    wagg.ingest(value, count);
  }
}

// Builds the per-second snapshot broadcast to the console (ui:metrics)
function buildRow(s) {
  const vus = s.metrics.get('vus');
  const checks = s.metrics.get('checks');
  const reqs = s.metrics.get('http_reqs');
  const failed = s.metrics.get('http_req_failed');
  const recv = s.metrics.get('data_received');
  const sent = s.metrics.get('data_sent');
  const iter = s.metrics.get('iterations');

  // Rates over the last second (global AND per-worker aggregates)
  for (const agg of s.metrics.values()) {
    agg.rate = agg.rateSum;
    agg.rateSum = 0;
  }
  for (const mm of s.metricsByWorker.values()) {
    for (const agg of mm.values()) {
      agg.rate = agg.rateSum;
      agg.rateSum = 0;
    }
  }

  // Fused VUS: sum of every worker's active VUS (the global "last" alone
  // only reflected the last worker that emitted).
  let vusTotal = 0;
  for (const mm of s.metricsByWorker.values()) {
    const va = mm.get('vus');
    if (va && va.last != null) vusTotal += va.last;
  }

  const row = {
    t: new Date().toISOString(),
    vus: { current: vusTotal, max: vus ? vus.max : 0 },
    checks: checks ? {
      pct: checks.count ? (checks.sum / checks.count) * 100 : null,
      count: checks.count
    } : null,
    rates: {
      httpReq: reqs ? reqs.rate : 0,
      httpFailed: failed ? failed.rate : 0,
      dataReceived: recv ? recv.rate : 0,
      dataSent: sent ? sent.rate : 0,
      iterations: iter ? iter.rate : 0
    },
    failedPct: reqs && failed && reqs.count ? (failed.sum / reqs.count) * 100 : null,
    metrics: {}
  };
  for (const [name, agg] of s.metrics) {
    const st = aggStats(agg);
    st.last = agg.last;
    row.metrics[name] = st;
  }

  // Per-worker statistics (per-agent curves in the console and the report)
  row.byWorker = {};
  for (const [wid, mm] of s.metricsByWorker) {
    const per = {};
    for (const [name, agg] of mm) {
      const st = aggStats(agg);
      st.last = agg.last; // instant gauge value (e.g. the worker's active VUS)
      per[name] = st;
    }
    row.byWorker[wid] = per;
  }

  if (vusTotal > s.vusPeak) s.vusPeak = vusTotal;

  s.history.push(row);
  if (s.history.length > MAX_HISTORY_ROWS) s.history.shift();
  return row;
}

// One snapshot per second as long as a session is running
export function startMetricsTicker(io) {
  setInterval(() => {
    const s = getCurrentSession();
    if (!s || s.status !== 'RUNNING') return;
    const row = buildRow(s);
    // `running: true` = live stream of the running test (the console re-attaches to it automatically)
    io.to('dashboard').emit('ui:metrics', { session: s.id, running: true, row });
  }, 1000);
}