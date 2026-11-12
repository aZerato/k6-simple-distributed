// HTML report (GET /api/test/report?format=html): self-contained page.
//
// Grid + axes rendered on the server side in SVG; the curves (one per series:
// merged + one per worker) are drawn by the embedded JS from `data`, so that
// the checkboxes can show/hide each series. Hovering (crosshair + tooltip)
// reads the values of ALL visible series at time t.
import { buildJsonReport } from './json.js';

function htmlEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtH(v, d = 2) {
  if (v == null || !isFinite(v)) return '—';
  return Number(v).toFixed(d);
}

function fmtBytesH(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a < 1000) return `${Math.round(v)} B`;
  if (a < 1e6) return `${(v / 1e3).toFixed(1)} kB`;
  if (a < 1e9) return `${(v / 1e6).toFixed(1)} MB`;
  return `${(v / 1e9).toFixed(1)} GB`;
}

function niceMaxH(v) {
  if (!isFinite(v) || v <= 0) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  const d = v / e;
  return (d <= 1 ? 1 : d <= 2 ? 2 : d <= 5 ? 5 : 10) * e;
}

// One report chart: grid + axes rendered on the server side; the curves
// (one per series) are drawn by the embedded JS from `data`, so that the
// checkboxes (merged / each worker) can show-hide each series.
// Returns { svg, data }: data drives the rendering, the hover (crosshair + tooltip).
function svgChart(times, seriesList) {
  const W = 880, H = 170, pL = 50, pR = 14, pT = 12, pB = 24;
  const iw = W - pL - pR, ih = H - pT - pB;
  const n = times.length;

  let max = 0;
  for (const s of seriesList) for (const v of s.values) if (v != null && isFinite(v) && v > max) max = v;
  const top = niceMaxH(max);

  const X = (i) => pL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const axisLbl = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : v % 1 ? v.toFixed(1) : String(v));
  const tLbl = (iso) => new Date(iso).toLocaleTimeString('en-US');

  let g = '';
  for (let i = 0; i <= 3; i++) {
    const y = pT + (ih / 3) * i;
    g += `<line x1="${pL}" y1="${y}" x2="${W - pR}" y2="${y}" class="gl"/>`;
    g += `<text x="${pL - 6}" y="${y + 3}" class="ax" text-anchor="end">${axisLbl(top * (1 - i / 3))}</text>`;
  }
  if (n > 0) {
    for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
      g += `<text x="${X(i).toFixed(1)}" y="${H - 8}" class="ax" text-anchor="middle">${htmlEsc(tLbl(times[i]))}</text>`;
    }
  }
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%">${g}<line class="crs" x1="0" y1="${pT}" x2="0" y2="${pT + ih}" style="display:none"/></svg>`;
  return { svg, data: { times, top, series: seriesList.map((s) => ({ name: s.name, color: s.color, fmt: s.fmt, dash: s.dash || null, values: s.values })) } };
}

export function buildHtmlReport(s) {
  const rep = buildJsonReport(s);
  const rows = rep.series.rows;
  const times = rows.map((r) => r.t);
  const M = (k) => rows.map((r) => (r.metrics[k] ? r.metrics[k].avg : null));
  const Mp = (k) => rows.map((r) => (r.metrics[k] ? r.metrics[k].p95 : null));
  const hasMetric = (k) => !!rep.metrics[k];

  // Curve colors per worker (distinct from the "merged" colors)
  const WPAL = ['#c084fc', '#45e3ff', '#ff8fa3', '#a3e635', '#f0abfc', '#ffd166'];
  const wcolor = (i) => WPAL[i % WPAL.length];

  // Workers that produced data points, in session order
  const present = new Set();
  for (const r of rows) for (const id of Object.keys(r.byWorker || {})) present.add(id);
  const workerIds = rep.workers.map((w) => w.id).filter((id) => present.has(id));

  // One series per worker; filtered out if this worker never emitted the metric
  const allNull = (arr) => arr.every((v) => v == null || !isFinite(v));
  const wSeries = (label, fmt, getter, dash) => workerIds.map((id, i) => {
    const values = rows.map((r) => {
      const bw = (r.byWorker || {})[id];
      const v = getter(bw);
      return v == null || !isFinite(v) ? null : v;
    });
    return { name: `${id} · ${label}`, color: wcolor(i), fmt, values, dash: dash || null };
  }).filter((sr) => !allNull(sr.values));

  const charts = [
    { title: 'VUS', list: [
      { name: 'Active VUS (merged)', color: '#46e5b1', fmt: 'int', values: rows.map((r) => r.vus) },
      ...wSeries('VUS', 'int', (bw) => (bw && bw.vus ? bw.vus.last : null)) ] },
    { title: 'HTTP req/s', list: [
      { name: 'req/s (merged)', color: '#46e5b1', fmt: 'int', values: rows.map((r) => r.reqRate) },
      { name: 'failed/s (merged)', color: '#ff5c5c', fmt: 'int', values: rows.map((r) => r.failedRate) },
      ...wSeries('req/s', 'int', (bw) => (bw && bw.http_reqs ? bw.http_reqs.rate : null)) ] },
    { title: 'Data (B/s)', list: [
      { name: 'received (merged)', color: '#5eb1ff', fmt: 'bps', values: rows.map((r) => r.dataRecvRate) },
      { name: 'sent (merged)', color: '#ffb224', fmt: 'bps', values: rows.map((r) => r.dataSentRate) },
      ...wSeries('received', 'bps', (bw) => (bw && bw.data_received ? bw.data_received.rate : null)) ] },
    ...(hasMetric('checks') ? [{ title: 'Checks passed (%)', list: [
      { name: 'checks % (merged)', color: '#46e5b1', fmt: 'pct', values: rows.map((r) => r.checksPct) },
      ...wSeries('checks %', 'pct', (bw) => (bw && bw.checks ? bw.checks.avg * 100 : null)) ] }] : []),
    ...(hasMetric('http_req_failed') ? [{ title: 'Failures (%)', list: [
      { name: 'failed % (merged)', color: '#ff5c5c', fmt: 'pct', values: rows.map((r) => r.failedPct) },
      ...wSeries('failed %', 'pct', (bw) => (bw && bw.http_req_failed ? bw.http_req_failed.avg * 100 : null)) ] }] : []),
    ...(hasMetric('iterations') ? [{ title: 'Iterations/s', list: [
      { name: 'iter/s (merged)', color: '#46e5b1', fmt: 'int', values: rows.map((r) => r.iterRate) },
      ...wSeries('iter/s', 'int', (bw) => (bw && bw.iterations ? bw.iterations.rate : null)) ] }] : [])
  ];
  const metricNames = Object.keys(rep.metrics).sort();
  for (const name of metricNames) {
    charts.push({ title: name, list: [
      { name: 'avg (merged)', color: '#46e5b1', fmt: 'num', values: M(name) },
      { name: 'p95 (merged)', color: '#ffb224', fmt: 'num', values: Mp(name) },
      ...wSeries('avg', 'num', (bw) => (bw && bw[name] ? bw[name].avg : null)),
      ...wSeries('p95', 'num', (bw) => (bw && bw[name] ? bw[name].p95 : null), '5 3') ] });
  }
  const built = charts.map((c) => svgChart(times, c.list));

  const t = rep.totals;
  const workersRows = rep.workers.map((w) => `
    <tr><td>${htmlEsc(w.id)}</td><td>${w.error ? htmlEsc(w.error) : (w.exitCode == null ? '—' : `code ${w.exitCode}`)}</td><td>${w.finishedAt ? htmlEsc(new Date(w.finishedAt).toLocaleString('en-US')) : '—'}</td></tr>`).join('');
  const metricRows = metricNames.map((name) => {
    const m = rep.metrics[name];
    return `<tr><td class="mn">${htmlEsc(name)}</td><td>${fmtH(m.count, 0)}</td><td>${fmtH(m.rate, 1)}</td><td>${fmtH(m.min)}</td><td>${fmtH(m.avg)}</td><td>${fmtH(m.p70)}</td><td>${fmtH(m.p80)}</td><td>${fmtH(m.p90)}</td><td>${fmtH(m.p95)}</td><td>${fmtH(m.p99)}</td><td>${fmtH(m.max)}</td></tr>`;
  }).join('');
  const logsHtml = Object.entries(rep.logs).map(([id, lines]) => `
    <details open><summary>${htmlEsc(id)} — ${lines.length} line(s)</summary><pre>${htmlEsc(lines.join('\n'))}</pre></details>`).join('');

  const genAt = new Date().toLocaleString('en-US');
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>k6 Report — ${htmlEsc(rep.session.id)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b1017; color: #c9d4e0; font: 14px/1.5 "IBM Plex Sans", "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 20px; letter-spacing: .04em; color: #e8f1f8; margin: 0 0 4px; }
  h2 { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: #46e5b1; margin: 30px 0 10px; }
  .sub { color: #7d8ca0; margin: 0 0 18px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 6px 10px; border-bottom: 1px solid rgba(140,165,195,.12); white-space: nowrap; }
  th { color: #7d8ca0; font-weight: 500; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
  th:first-child, td.mn { text-align: left; }
  .mn { color: #9fd8c0; }
  tr:hover td { background: rgba(70,229,177,.05); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
  .cell { border: 1px solid rgba(140,165,195,.15); border-radius: 8px; padding: 10px 12px; }
  .cell b { display: block; font-size: 18px; color: #e8f1f8; }
  .cell span { color: #7d8ca0; font-size: 12px; }
  figure.rpt-chart { margin: 0 0 16px; border: 1px solid rgba(140,165,195,.15); border-radius: 8px; padding: 8px 10px; }
  .rpt-chart figcaption { color: #9fb0c4; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; margin-bottom: 4px; }
  .sr-row { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 8px; }
  .sr { display: inline-flex; align-items: center; gap: 5px; font: 11px "IBM Plex Mono", ui-monospace, monospace; color: #9fb0c4; cursor: pointer; user-select: none; }
  .sr input { accent-color: #46e5b1; cursor: pointer; }
  .sr .sw { width: 10px; height: 3px; border-radius: 2px; display: inline-block; }
  svg { display: block; }
  .gl { stroke: rgba(160,180,210,.08); }
  .ax { fill: rgba(125,140,160,.85); font: 10px "IBM Plex Mono", ui-monospace, monospace; }
  .crs { stroke: rgba(220,235,255,.4); stroke-dasharray: 3 3; }
  #tip { position: fixed; display: none; pointer-events: none; background: #101823; border: 1px solid rgba(70,229,177,.4); border-radius: 6px; padding: 6px 9px; font: 12px/1.6 "IBM Plex Mono", ui-monospace, monospace; color: #d7e3ee; z-index: 10; white-space: nowrap; }
  #tip .tt { color: #46e5b1; }
  summary { cursor: pointer; color: #9fb0c4; }
  pre { background: #0d141d; border: 1px solid rgba(140,165,195,.15); border-radius: 6px; padding: 10px; font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; overflow-x: auto; }
  .foot { margin-top: 36px; color: #5c6b80; font-size: 12px; }
  .foot a { color: #46e5b1; text-decoration: none; }
  .foot a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="wrap">
  <h1>k6 distributed report</h1>
  <p class="sub">${htmlEsc(rep.session.id)} — ${htmlEsc(rep.session.overall)} · ${htmlEsc(String(rep.session.totalVus))} VUs · duration ${htmlEsc(String(rep.session.duration))}</p>

  <h2>Summary</h2>
  <div class="grid">
    <div class="cell"><span>Max VUS</span><b>${fmtH(t.vusMax, 0)}</b></div>
    <div class="cell"><span>HTTP requests</span><b>${fmtH(t.httpReqs, 0)}</b></div>
    <div class="cell"><span>Failure rate</span><b>${fmtH(t.failedPct)} %</b></div>
    <div class="cell"><span>Data received</span><b>${fmtBytesH(t.dataReceived)}</b></div>
    <div class="cell"><span>Data sent</span><b>${fmtBytesH(t.dataSent)}</b></div>
    <div class="cell"><span>Iterations</span><b>${fmtH(t.iterations, 0)}</b></div>
    <div class="cell"><span>Checks</span><b>${fmtH(t.checksPct)} %</b></div>
  </div>

  <h2>Workers</h2>
  <table>
    <thead><tr><th>Worker</th><th>Result</th><th>End</th></tr></thead>
    <tbody>${workersRows}</tbody>
  </table>

  <h2>Charts</h2>
  <p class="sub">Each chart carries the merged curve and one curve per worker — check a series to show or hide it.</p>
  ${built.map((b, i) => `
  <figure class="rpt-chart">
    <figcaption>${htmlEsc(charts[i].title)}</figcaption>
    <div class="sr-row">${b.data.series.map((sr, k) => `<label class="sr"><input type="checkbox" checked data-s="${k}"><i class="sw" style="background:${sr.color}"></i>${htmlEsc(sr.name)}</label>`).join('')}</div>
    ${b.svg}
  </figure>`).join('')}

  <h2>All metrics</h2>
  <table>
    <thead><tr><th>Metric</th><th>count</th><th>rate</th><th>min</th><th>avg</th><th>p70</th><th>p80</th><th>p90</th><th>p95</th><th>p99</th><th>max</th></tr></thead>
    <tbody>${metricRows}</tbody>
  </table>

  <h2>Logs per worker</h2>
  ${logsHtml || '<p class="sub">No logs.</p>'}

  <p class="foot">Generated on ${genAt} by the <a href="https://github.com/aZerato/k6-simple-distributed">distributed k6 orchestrator</a> — hover over the charts to read the values at time t.</p>
</div>
<div id="tip"></div>
<script>
(function () {
  var DATA = ${JSON.stringify({ times: times, charts: built.map((b) => b.data) }).replace(/</g, '\\u003c')};
  var W = 880, H = 170, pL = 50, pR = 14, pT = 12, pB = 24;
  var iw = W - pL - pR, ih = H - pT - pB;
  var NS = 'http://www.w3.org/2000/svg';
  var F = {
    int: function (v) { return v == null ? '—' : Math.round(v).toLocaleString('en-US'); },
    num: function (v) { return v == null ? '—' : Number(v).toFixed(2); },
    pct: function (v) { return v == null ? '—' : Number(v).toFixed(2) + ' %'; },
    bps: function (v) { return v == null ? '—' : (v < 1000 ? Math.round(v) + ' B/s' : v < 1e6 ? (v / 1e3).toFixed(1) + ' kB/s' : (v / 1e6).toFixed(2) + ' MB/s'); }
  };
  var tip = document.getElementById('tip');
  document.querySelectorAll('figure.rpt-chart').forEach(function (fig, k) {
    var d = DATA.charts[k];
    if (!d) return;
    var times = d.times;
    var n = times.length;
    var top = d.top || 1;
    var svg = fig.querySelector('svg');
    var crs = svg.querySelector('.crs');
    var g = document.createElementNS(NS, 'g');
    var X = function (i) { return pL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw); };
    var Y = function (v) { return pT + ih - (v / top) * ih; };
    d.series.forEach(function (s) {
      var p = document.createElementNS(NS, 'path');
      var dd = '';
      var pen = false;
      s.values.forEach(function (v, i) {
        if (v == null || !isFinite(v)) { pen = false; return; }
        dd += (pen ? ' L' : ' M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
        pen = true;
      });
      p.setAttribute('d', dd.trim() || 'M0 0');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', s.color);
      p.setAttribute('stroke-width', s.dash ? '1.4' : '2');
      p.setAttribute('stroke-linejoin', 'round');
      if (s.dash) p.setAttribute('stroke-dasharray', s.dash);
      g.appendChild(p);
    });
    svg.insertBefore(g, crs);
    svg.addEventListener('mousemove', function (ev) {
      if (!n) return;
      var r = svg.getBoundingClientRect();
      var scale = r.width / W;
      var mx = (ev.clientX - r.left) / scale;
      var i = n === 1 ? 0 : Math.round(((mx - pL) / iw) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      var x = pL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
      crs.setAttribute('x1', x);
      crs.setAttribute('x2', x);
      crs.style.display = '';
      var html = '<span class="tt">' + new Date(times[i]).toLocaleString('en-US') + '</span>';
      d.series.forEach(function (s, si) {
        if (g.children[si] && g.children[si].style.display === 'none') return;
        html += '<br>' + s.name + ' : ' + (F[s.fmt] || F.num)(s.values[i]);
      });
      tip.innerHTML = html;
      tip.style.display = 'block';
      var tw = tip.offsetWidth;
      var lx = ev.clientX + 14;
      if (lx + tw > window.innerWidth - 8) lx = ev.clientX - tw - 14;
      tip.style.left = lx + 'px';
      tip.style.top = Math.max(8, ev.clientY - 12) + 'px';
    });
    svg.addEventListener('mouseleave', function () {
      crs.style.display = 'none';
      tip.style.display = 'none';
    });
    fig.querySelectorAll('.sr input').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var p = g.children[+inp.getAttribute('data-s')];
        if (p) p.style.display = inp.checked ? '' : 'none';
      });
    });
  });
})();
</script>
</body>
</html>`;
  return page;
}
