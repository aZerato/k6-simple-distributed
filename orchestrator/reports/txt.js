// Text report (GET /api/test/report?format=txt): human-readable summary of the session.
import { dateFull, fmtBytes, stamp } from '../utils.js';
import { sessionOverallStatus, vusOf } from '../state.js';
import { finalStats } from './json.js';

export function buildTxtReport(s) {
  const W = 78;
  const bar = (ch = '-') => ch.repeat(W);
  const out = [];

  out.push(bar('='));
  out.push('  k6 DISTRIBUTED TEST REPORT (summary)');
  out.push(bar('='));
  out.push('');
  out.push('  SESSION');
  out.push(`  ID             : ${s.id}`);
  out.push(`  Overall status : ${s.status === 'RUNNING' ? 'IN PROGRESS' : `FINISHED — ${sessionOverallStatus(s)}`}`);
  out.push(`  Start          : ${dateFull(s.createdAt)}`);
  out.push(`  End            : ${s.finishedAt ? dateFull(s.finishedAt) : '—'}`);
  out.push(`  Total VUS      : ${s.totalVus}`);
  out.push(`  Duration asked : ${s.duration}`);
  out.push('');
  out.push('  WORKERS');
  if (s.workers.size === 0) {
    out.push('  (no worker targeted)');
  } else {
    for (const [id, w] of s.workers) {
      const res = w.error ? `error: ${w.error}` : `exit code ${w.exitCode}`;
      const fin = w.finishedAt ? ` — ${stamp(w.finishedAt)}` : '';
      out.push(`  - ${id.padEnd(28)} : ${res}${fin}`);
    }
  }

  const reqs = s.metrics.get('http_reqs');
  const failed = s.metrics.get('http_req_failed');
  const recv = s.metrics.get('data_received');
  const sent = s.metrics.get('data_sent');
  const iter = s.metrics.get('iterations');
  const checks = s.metrics.get('checks');

  out.push('');
  out.push('  GLOBAL SUMMARY');
  out.push(`  Max VUS         : ${vusOf(s) ? vusOf(s).max : 0}`);
  out.push(`  Iterations      : ${iter ? iter.count : 0}`);
  out.push(`  HTTP requests   : ${reqs ? reqs.count : 0}${failed ? ` (failures: ${Math.round(failed.sum)}, i.e. ${reqs && reqs.count ? ((failed.sum / reqs.count) * 100).toFixed(2) : '—'}%)` : ''}`);
  out.push(`  Data received   : ${fmtBytes(recv ? recv.sum : 0)}`);
  out.push(`  Data sent       : ${fmtBytes(sent ? sent.sum : 0)}`);
  out.push(`  Checks passed   : ${checks && checks.count ? `${((checks.sum / checks.count) * 100).toFixed(2)}% (${checks.count})` : '—'}`);

  out.push('');
  out.push('  METRICS (global statistics — percentiles over the latest values)');
  for (const [name, st] of Object.entries(finalStats(s))) {
    out.push(
      `  ${name.padEnd(26)} count=${String(st.count).padStart(8)}  avg=${st.avg == null ? '—' : st.avg.toFixed(2)}  min=${st.min == null ? '—' : st.min.toFixed(2)}  max=${st.max == null ? '—' : st.max.toFixed(2)}  p95=${st.p95 == null ? '—' : st.p95.toFixed(2)}  p99=${st.p99 == null ? '—' : st.p99.toFixed(2)}`
    );
  }

  out.push('');
  out.push('  METRICS PER WORKER');
  for (const [wid, mm] of s.metricsByWorker) {
    const reqsW = mm.get('http_reqs');
    const failedW = mm.get('http_req_failed');
    const recvW = mm.get('data_received');
    const iterW = mm.get('iterations');
    const vusW = mm.get('vus');
    out.push(`  --- ${wid} ---`);
    out.push(`    Max VUS: ${Math.round(vusW && vusW.last != null ? vusW.last : 0)}   Requests: ${reqsW ? Math.round(reqsW.count) : 0}   Failures: ${failedW ? Math.round(failedW.sum) : 0}`);
    out.push(`    Data received: ${fmtBytes(recvW ? recvW.sum : 0)}   Iterations: ${iterW ? Math.round(iterW.count) : 0}`);
  }
  if (s.metricsByWorker.size === 0) out.push('  (no data points received)');

  out.push('');
  out.push(bar());
  out.push('  LOGS PER WORKER');
  out.push(bar());
  for (const [id, arr] of s.workerLogs) {
    out.push(`  --- ${id} ---`);
    for (const l of arr) {
      out.push(`  [${stamp(l.t)}] [${l.type.toUpperCase()}] ${l.text}`);
    }
  }
  out.push(bar());
  out.push('  END OF REPORT');
  out.push(bar('='));

  return out.join('\n');
}