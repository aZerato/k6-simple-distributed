/* ============================================================
   Canvas drawing engine (ported from public/app.js, dependency-free)
   + definitions of the charts / series / summary cards.
   ============================================================ */
import { fmtInt, fmtNum, fmtPct, fmtBytesRate } from './format';

/* ---------- Per-worker curve palette (distinct from the "merged" colors) ---------- */

export const WORKER_PALETTE = ['#c084fc', '#45e3ff', '#ff8fa3', '#a3e635', '#f0abfc', '#ffd166'];
export const workerColor = (i) => WORKER_PALETTE[i % WORKER_PALETTE.length];

/* ---------- Raw canvas values ---------- */

export function prep(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(20, canvas.clientWidth || 300);
  const h = Math.max(20, canvas.clientHeight || 160);
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function niceMax(v) {
  if (!isFinite(v) || v <= 0) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  const d = v / e;
  return (d <= 1 ? 1 : d <= 2 ? 2 : d <= 5 ? 5 : 10) * e;
}

export function axisLabel(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v % 1 ? v.toFixed(1) : String(v);
}

/*
 * valuesBySeries : array of arrays (one per series), indexed by time.
 * hoverIndex >= 0 : draws a vertical marker + a dot on each series.
 */
export function drawLines(canvas, rows, seriesDef, valuesBySeries, hoverIndex = -1) {
  const { ctx, w, h } = prep(canvas);
  const padT = 6, padB = 16, padL = 8, padR = 8;
  const iw = w - padL - padR;
  const ih = h - padT - padB;

  // Horizontal grid
  ctx.strokeStyle = 'rgba(160,180,210,0.07)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = Math.round(padT + (ih / 3) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  const n = rows.length;
  if (!n) {
    ctx.fillStyle = 'rgba(120,135,160,0.55)';
    ctx.font = '12px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('waiting for data…', w / 2, h / 2);
    return;
  }

  let max = 0;
  for (const arr of valuesBySeries) for (const v of arr) if (v > max) max = v;
  const top = niceMax(max || 1);

  // Axis ticks
  ctx.font = '9.5px "IBM Plex Mono", monospace';
  ctx.fillStyle = 'rgba(120,135,160,0.6)';
  ctx.textAlign = 'left';
  for (let i = 0; i <= 3; i++) {
    const y = padT + (ih / 3) * i;
    ctx.fillText(axisLabel(top * (1 - i / 3)), padL + 2, y + 3);
  }

  const x = (j) => padL + (n === 1 ? 0 : (j / (n - 1)) * iw);
  const y = (v) => padT + ih - (v / top) * ih;

  seriesDef.forEach((s, i) => {
    const arr = valuesBySeries[i];
    if (s.fill) {
      const g = ctx.createLinearGradient(0, padT, 0, h);
      g.addColorStop(0, s.fill);
      g.addColorStop(1, 'transparent');
      ctx.beginPath();
      arr.forEach((v, j) => (j ? ctx.lineTo(x(j), y(v)) : ctx.moveTo(x(0), y(v))));
      ctx.lineTo(x(n - 1), padT + ih);
      ctx.lineTo(x(0), padT + ih);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.beginPath();
    arr.forEach((v, j) => (j ? ctx.lineTo(x(j), y(v)) : ctx.moveTo(x(0), y(v))));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.setLineDash(s.dash ? s.dash.split(' ').map(Number) : []);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // Hover marker: vertical line + dot on each series
  if (hoverIndex != null && hoverIndex >= 0 && hoverIndex < n) {
    const hx = x(hoverIndex);
    ctx.strokeStyle = 'rgba(220,235,255,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, padT);
    ctx.lineTo(hx, padT + ih);
    ctx.stroke();
    ctx.setLineDash([]);
    valuesBySeries.forEach((arr, i) => {
      const v = arr[hoverIndex];
      if (v == null) return;
      ctx.beginPath();
      ctx.arc(hx, y(v), 3, 0, Math.PI * 2);
      ctx.fillStyle = seriesDef[i].color;
      ctx.fill();
    });
  }
}

export function drawSpark(canvas, values, color) {
  const { ctx, w, h } = prep(canvas);
  if (!values.length) return;
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (max <= 0) return;
  ctx.beginPath();
  values.forEach((v, j) => {
    const X = 1 + (j / (values.length - 1 || 1)) * (w - 2);
    const Y = h - 2 - (v / max) * (h - 4);
    j ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

/* ---------- Series: merged + one per worker ---------- */

// Value of a metric for a given worker (0 as long as the worker does not emit)
export function wStat(r, wid, metric, key, mult = 1) {
  const bw = (r.byWorker || {})[wid];
  const v = bw && bw[metric] ? bw[metric][key] : null;
  return v == null || !isFinite(v) ? 0 : v * mult;
}

/*
 * Complete list of a chart's series: the merged curves first,
 * then one (or two) curve(s) per worker, in order of appearance.
 */
export function buildSeries(c, workerIds) {
  const out = [];
  c.fusion.forEach((f, i) => {
    out.push({
      id: `${c.key}/f-${i}`,
      kind: 'fusion',
      label: f.label,
      color: c.colors[i],
      dash: null,
      fill: i === 0 ? c.fill : null,
      get: f.get,
      fmt: f.fmt
    });
  });
  workerIds.forEach((wid, wi) => {
    const col = workerColor(wi);
    c.workerRoles.forEach((role, ri) => {
      out.push({
        id: `${c.key}/w-${wi}-${ri}`,
        kind: 'worker',
        label: `${wid} · ${role.label}`,
        color: col,
        dash: ri > 0 ? '4 4' : null,
        fill: null,
        get: (r) => role.get(r, wid),
        fmt: role.fmt
      });
    });
  });
  return out;
}

// Visibility of a series: an explicit per-series override (checkbox) wins,
// otherwise the global "curve mode" decides —
//   fusion  : merged curves only
//   workers : per-worker curves only
//   all     : merged + per-worker curves
export const isSeriesOn = (mode, manual, s) => {
  if (manual.has(s.id)) return manual.get(s.id);
  return s.kind === 'fusion'
    ? (mode === 'fusion' || mode === 'all')
    : (mode === 'workers' || mode === 'all');
};

// Drawing of a chart: visible series + values over the `rows`.
export function drawSeries(canvas, c, { rows, workerIds, mode, manual, hoverIndex = -1 }) {
  const series = buildSeries(c, workerIds).filter((s) => isSeriesOn(mode, manual, s));
  const vals = series.map((s) => rows.map((r) => s.get(r)));
  drawLines(canvas, rows, series, vals, hoverIndex);
}

/* ---------- Definitions of the main charts ----------
 * Each chart carries:
 *  - the MERGED curves (every worker, aggregated by the orchestrator),
 *  - one curve per WORKER (r.byWorker), show/hide via checkbox.
 * The workers' curves are drawn dashed (same color, second role).
 */
export const CHART_DEFS = [
  {
    key: 'http',
    fusion: [
      { label: 'req/s', get: (r) => r.rates.httpReq, fmt: fmtInt },
      { label: 'failed/s', get: (r) => r.rates.httpFailed, fmt: fmtInt }
    ],
    workerRoles: [
      { label: 'req/s', get: (r, wid) => wStat(r, wid, 'http_reqs', 'rate'), fmt: fmtInt },
      { label: 'failed/s', get: (r, wid) => wStat(r, wid, 'http_req_failed', 'rate'), fmt: fmtInt }
    ],
    colors: ['#46e5b1', '#ff5c5c'],
    fill: 'rgba(70,229,177,0.10)'
  },
  {
    key: 'data',
    fusion: [
      { label: 'received', get: (r) => r.rates.dataReceived, fmt: fmtBytesRate },
      { label: 'sent', get: (r) => r.rates.dataSent, fmt: fmtBytesRate }
    ],
    workerRoles: [
      { label: 'received', get: (r, wid) => wStat(r, wid, 'data_received', 'rate'), fmt: fmtBytesRate },
      { label: 'sent', get: (r, wid) => wStat(r, wid, 'data_sent', 'rate'), fmt: fmtBytesRate }
    ],
    colors: ['#5eb1ff', '#ffb224'],
    fill: 'rgba(94,177,255,0.10)'
  },
  {
    key: 'vus',
    fusion: [
      { label: 'active', get: (r) => r.vus.current, fmt: fmtInt }
    ],
    workerRoles: [
      { label: 'VUS', get: (r, wid) => wStat(r, wid, 'vus', 'last'), fmt: fmtInt }
    ],
    colors: ['#46e5b1'],
    fill: 'rgba(70,229,177,0.14)'
  },
  {
    key: 'checks',
    fusion: [
      { label: 'checks %', get: (r) => (r.checks && r.checks.pct != null ? r.checks.pct : 0), fmt: fmtPct }
    ],
    workerRoles: [
      { label: 'checks %', get: (r, wid) => wStat(r, wid, 'checks', 'avg', 100), fmt: fmtPct }
    ],
    colors: ['#46e5b1'],
    fill: 'rgba(70,229,177,0.14)'
  }
];

// Definition of the "Metric" chart (explorer selection).
export function metricDef(metricName) {
  return {
    key: 'metric',
    fusion: [
      { label: 'avg', get: (r) => (r.metrics[metricName] ? r.metrics[metricName].avg : 0) || 0, fmt: fmtNum },
      { label: 'p95', get: (r) => (r.metrics[metricName] ? r.metrics[metricName].p95 : 0) || 0, fmt: fmtNum }
    ],
    workerRoles: [
      { label: 'avg', get: (r, wid) => wStat(r, wid, metricName, 'avg'), fmt: fmtNum },
      { label: 'p95', get: (r, wid) => wStat(r, wid, metricName, 'p95'), fmt: fmtNum }
    ],
    colors: ['#46e5b1', '#ffb224'],
    fill: 'rgba(70,229,177,0.10)'
  };
}

/* ---------- Summary cards (k6-dashboard style) ---------- */

export const CARDS = [
  { label: 'VUS', get: (r) => r.vus.current, fmt: fmtInt, spark: (r) => r.vus.current, color: '#46e5b1' },
  { label: 'HTTP req/s', get: (r) => r.rates.httpReq, fmt: fmtInt, spark: (r) => r.rates.httpReq, color: '#46e5b1' },
  { label: 'Failures /s', get: (r) => r.rates.httpFailed, fmt: fmtInt, spark: (r) => r.rates.httpFailed, color: '#ff5c5c', neg: true },
  { label: 'Checks passed', get: (r) => (r.checks ? r.checks.pct : null), fmt: fmtPct, spark: (r) => (r.checks && r.checks.pct != null ? r.checks.pct : 0), color: '#46e5b1' },
  { label: 'Iterations /s', get: (r) => r.rates.iterations, fmt: fmtInt, spark: (r) => r.rates.iterations, color: '#46e5b1' },
  { label: 'Data received', get: (r) => r.rates.dataReceived, fmt: fmtBytesRate, spark: (r) => r.rates.dataReceived, color: '#5eb1ff' },
  { label: 'Data sent', get: (r) => r.rates.dataSent, fmt: fmtBytesRate, spark: (r) => r.rates.dataSent, color: '#ffb224' }
];

/* ---------- Hover tooltip (value at time t) ---------- */

export function showChartTip(tipEl, e, html) {
  tipEl.innerHTML = html;
  tipEl.style.display = 'block';
  const tw = tipEl.offsetWidth;
  let lx = e.clientX + 14;
  if (lx + tw > window.innerWidth - 8) lx = e.clientX - tw - 14;
  tipEl.style.left = `${lx}px`;
  tipEl.style.top = `${Math.max(8, e.clientY - tipEl.offsetHeight - 6)}px`;
}

export function hideChartTip(tipEl) {
  tipEl.style.display = 'none';
}

/* ---------- Hover index (value at time t) ---------- */

export function chartIndexFromX(canvas, x, n) {
  if (n <= 0) return -1;
  if (n === 1) return 0;
  const w = canvas.clientWidth || 300;
  const padL = 8, padR = 8;
  const iw = w - padL - padR;
  const i = Math.round(((x - padL) / iw) * (n - 1));
  return Math.max(0, Math.min(n - 1, i));
}

/* ---------- Known metrics (explorer selection) ---------- */

export function knownMetrics(rows) {
  const out = [];
  for (const r of rows) for (const k of Object.keys(r.metrics)) if (!out.includes(k)) out.push(k);
  return out;
}
