// Rapport texte (GET /api/test/report?format=txt) : résumé lisible de la session.
import { dateFr, fmtBytes, stamp } from '../utils.js';
import { sessionOverallStatus, vusOf } from '../state.js';
import { finalStats } from './json.js';

export function buildTxtReport(s) {
  const W = 78;
  const bar = (ch = '-') => ch.repeat(W);
  const out = [];

  out.push(bar('='));
  out.push('  RAPPORT DE TEST k6 DISTRIBUÉ (résumé)');
  out.push(bar('='));
  out.push('');
  out.push('  SESSION');
  out.push(`  Identifiant    : ${s.id}`);
  out.push(`  Statut global  : ${s.status === 'RUNNING' ? 'EN COURS' : `TERMINÉ — ${sessionOverallStatus(s)}`}`);
  out.push(`  Début          : ${dateFr(s.createdAt)}`);
  out.push(`  Fin            : ${s.finishedAt ? dateFr(s.finishedAt) : '—'}`);
  out.push(`  VUS totales    : ${s.totalVus}`);
  out.push(`  Durée demandée : ${s.duration}`);
  out.push('');
  out.push('  WORKERS');
  if (s.workers.size === 0) {
    out.push('  (aucun worker ciblé)');
  } else {
    for (const [id, w] of s.workers) {
      const res = w.error ? `erreur : ${w.error}` : `code de sortie ${w.exitCode}`;
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
  out.push('  RÉSUMÉ GLOBAL');
  out.push(`  VUS max          : ${vusOf(s) ? vusOf(s).max : 0}`);
  out.push(`  Itérations       : ${iter ? iter.count : 0}`);
  out.push(`  Requêtes HTTP    : ${reqs ? reqs.count : 0}${failed ? ` (échecs : ${Math.round(failed.sum)}, soit ${reqs && reqs.count ? ((failed.sum / reqs.count) * 100).toFixed(2) : '—'}%)` : ''}`);
  out.push(`  Données reçues   : ${fmtBytes(recv ? recv.sum : 0)}`);
  out.push(`  Données envoyées : ${fmtBytes(sent ? sent.sum : 0)}`);
  out.push(`  Checks passés    : ${checks && checks.count ? `${((checks.sum / checks.count) * 100).toFixed(2)}% (${checks.count})` : '—'}`);

  out.push('');
  out.push('  MÉTRIQUES (statistiques globales — percentiles sur les dernières valeurs)');
  for (const [name, st] of Object.entries(finalStats(s))) {
    out.push(
      `  ${name.padEnd(26)} count=${String(st.count).padStart(8)}  avg=${st.avg == null ? '—' : st.avg.toFixed(2)}  min=${st.min == null ? '—' : st.min.toFixed(2)}  max=${st.max == null ? '—' : st.max.toFixed(2)}  p95=${st.p95 == null ? '—' : st.p95.toFixed(2)}  p99=${st.p99 == null ? '—' : st.p99.toFixed(2)}`
    );
  }

  out.push('');
  out.push('  MÉTRIQUES PAR WORKER');
  for (const [wid, mm] of s.metricsByWorker) {
    const reqsW = mm.get('http_reqs');
    const failedW = mm.get('http_req_failed');
    const recvW = mm.get('data_received');
    const iterW = mm.get('iterations');
    const vusW = mm.get('vus');
    out.push(`  --- ${wid} ---`);
    out.push(`    VUS max : ${Math.round(vusW && vusW.last != null ? vusW.last : 0)}   Requêtes : ${reqsW ? Math.round(reqsW.count) : 0}   Échecs : ${failedW ? Math.round(failedW.sum) : 0}`);
    out.push(`    Données reçues : ${fmtBytes(recvW ? recvW.sum : 0)}   Itérations : ${iterW ? Math.round(iterW.count) : 0}`);
  }
  if (s.metricsByWorker.size === 0) out.push('  (aucun point de données reçu)');

  out.push('');
  out.push(bar());
  out.push('  LOGS PAR WORKER');
  out.push(bar());
  for (const [id, arr] of s.workerLogs) {
    out.push(`  --- ${id} ---`);
    for (const l of arr) {
      out.push(`  [${stamp(l.t)}] [${l.type.toUpperCase()}] ${l.text}`);
    }
  }
  out.push(bar());
  out.push('  FIN DU RAPPORT');
  out.push(bar('='));

  return out.join('\n');
}
