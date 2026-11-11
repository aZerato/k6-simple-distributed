// Agrégation des métriques k6 (flux `worker:metrics`).
//
// Deux niveaux d'agrégat par session :
//   - `s.metrics`         : fusion de tous les workers (courbes principales) ;
//   - `s.metricsByWorker` : un agrégat par worker (courbes par agent).
// Un snapshot par seconde (`buildRow`) est diffusé vers la console (ui:metrics).
import { RING_CAPACITY, MAX_HISTORY_ROWS, MAX_RAW_LINES_PER_WORKER } from './constants.js';
import { getCurrentSession } from './state.js';

// Fenêtre circulaire : permet de recalculer les percentiles sur les dernières valeurs.
class MetricAgg {
  constructor() {
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.last = null;
    this.rateSum = 0;   // accumulé depuis le dernier tick (seconde)
    this.rate = 0;      // valeur du dernier tick
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

  // Copie des valeurs de la fenêtre, dans l'ordre chronologique
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

// Ingestion d'un lot de points de données k6 (envoyés par le worker)
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
    // JSON brut k6, ligne par ligne (re-téléchargeable via /api/raw-metrics)
    if (raw.length < MAX_RAW_LINES_PER_WORKER) {
      raw.push(JSON.stringify({ metric: item.metric, data: item.data }));
    } else if (!s.rawTruncated) {
      s.rawTruncated = true;
      console.warn(`[Orchestrateur] Buffer JSON brut saturé pour ${workerId} (plafond ${MAX_RAW_LINES_PER_WORKER} lignes).`);
    }
    // Les lignes de métadonnées k6 (sans `value`) alimentent le brut, pas l'agrégation
    if (typeof item.data.value !== 'number') continue;
    const count = Math.max(1, item.data.count || 1);
    const value = Number(item.data.value) || 0;
    // Agrégat global (fusion de tous les workers)
    let agg = s.metrics.get(item.metric);
    if (!agg) {
      agg = new MetricAgg();
      s.metrics.set(item.metric, agg);
    }
    agg.ingest(value, count);
    // Agrégat par worker : alimente les courbes par agent de la console et du rapport
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

// Construit le snapshot par seconde diffusé vers la console (ui:metrics)
function buildRow(s) {
  const vus = s.metrics.get('vus');
  const checks = s.metrics.get('checks');
  const reqs = s.metrics.get('http_reqs');
  const failed = s.metrics.get('http_req_failed');
  const recv = s.metrics.get('data_received');
  const sent = s.metrics.get('data_sent');
  const iter = s.metrics.get('iterations');

  // Taux sur la dernière seconde (agrégats globaux ET par worker)
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

  // VUS fusionnés : somme des VUS actifs de chaque worker (le « last » global
  // tout seul ne reflétait que le dernier worker qui a émis).
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

  // Statistiques par worker (courbes par agent dans la console et le rapport)
  row.byWorker = {};
  for (const [wid, mm] of s.metricsByWorker) {
    const per = {};
    for (const [name, agg] of mm) {
      const st = aggStats(agg);
      st.last = agg.last; // valeur instantanée du gauge (ex: VUS actifs du worker)
      per[name] = st;
    }
    row.byWorker[wid] = per;
  }

  if (vusTotal > s.vusPeak) s.vusPeak = vusTotal;

  s.history.push(row);
  if (s.history.length > MAX_HISTORY_ROWS) s.history.shift();
  return row;
}

// Un snapshot par seconde tant qu'une session est en cours
export function startMetricsTicker(io) {
  setInterval(() => {
    const s = getCurrentSession();
    if (!s || s.status !== 'RUNNING') return;
    const row = buildRow(s);
    // `running: true` = flux live du test en cours (la console s'y rattache d'office)
    io.to('dashboard').emit('ui:metrics', { session: s.id, running: true, row });
  }, 1000);
}
