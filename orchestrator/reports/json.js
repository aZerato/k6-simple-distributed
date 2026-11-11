// JSON report (GET /api/test/report):
//   per-second series + final statistics (fusion and per worker) + logs.
import { aggStats } from '../metrics.js';
import { stamp } from '../utils.js';
import { sessionOverallStatus } from '../state.js';

// A bit of per-metric statistics for the series (report / JSON lines)
function slimStats(v) {
  return {
    count: v.count,
    rate: v.rate,
    avg: v.avg,
    min: v.min,
    max: v.max,
    p70: v.p70,
    p80: v.p80,
    p90: v.p90,
    p95: v.p95,
    p99: v.p99,
    last: v.last != null ? v.last : null
  };
}

function slimRow(r) {
  const m = {};
  for (const [k, v] of Object.entries(r.metrics)) m[k] = slimStats(v);
  const bw = {};
  for (const [k, mm] of Object.entries(r.byWorker || {})) {
    const per = {};
    for (const [mk, v] of Object.entries(mm)) per[mk] = slimStats(v);
    bw[k] = per;
  }
  return {
    t: r.t,
    vus: r.vus.current,
    vusMax: r.vus.max,
    checksPct: r.checks ? r.checks.pct : null,
    reqRate: r.rates.httpReq,
    failedRate: r.rates.httpFailed,
    failedPct: r.failedPct,
    dataRecvRate: r.rates.dataReceived,
    dataSentRate: r.rates.dataSent,
    iterRate: r.rates.iterations,
    metrics: m,
    byWorker: bw
  };
}

function finalStatsOf(mm) {
  const out = {};
  for (const [name, agg] of mm) {
    const st = aggStats(agg);
    st.last = agg.last;
    out[name] = st;
  }
  return out;
}

export function finalStats(s) {
  return finalStatsOf(s.metrics);
}

export function buildJsonReport(s) {
  const vus = s.metrics.get('vus');
  const reqs = s.metrics.get('http_reqs');
  const failed = s.metrics.get('http_req_failed');
  const recv = s.metrics.get('data_received');
  const sent = s.metrics.get('data_sent');
  const iter = s.metrics.get('iterations');
  const checks = s.metrics.get('checks');

  const logs = {};
  for (const [id, arr] of s.workerLogs) {
    logs[id] = arr.map((l) => `[${stamp(l.t)}] [${l.type.toUpperCase()}] ${l.text}`);
  }

  return {
    format: 'k6-distributed-report',
    version: 1,
    session: {
      id: s.id,
      status: s.status,
      overall: sessionOverallStatus(s),
      createdAt: s.createdAt.toISOString(),
      finishedAt: s.finishedAt ? s.finishedAt.toISOString() : null,
      totalVus: s.totalVus,
      duration: s.duration
    },
    workers: [...s.workers.entries()].map(([id, w]) => ({
      id,
      exitCode: w.exitCode,
      finishedAt: w.finishedAt ? w.finishedAt.toISOString() : null,
      error: w.error
    })),
    byWorker: [...s.metricsByWorker.entries()].map(([id, mm]) => ({ id, metrics: finalStatsOf(mm) })),
    totals: {
      vusMax: s.vusPeak || (vus ? vus.max : 0),
      httpReqs: reqs ? reqs.count : 0,
      httpFailed: failed ? failed.sum : 0,
      failedPct: reqs && reqs.count ? (failed.sum / reqs.count) * 100 : null,
      dataReceived: recv ? recv.sum : 0,
      dataSent: sent ? sent.sum : 0,
      iterations: iter ? iter.count : 0,
      checksPct: checks && checks.count ? (checks.sum / checks.count) * 100 : null,
      checksCount: checks ? checks.count : 0
    },
    metrics: finalStats(s),
    series: { intervalSec: 1, rows: s.history.map(slimRow) },
    logs
  };
}
