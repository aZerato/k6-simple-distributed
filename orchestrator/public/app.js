/* ============================================================
   k6 Orchestrator — Console web (app.js)
   - Graphiques temps réel sur les métriques k6 agrégées (ui:metrics)
   - Logs par worker (pas de concaténation : onglets par agent)
   - Rapports .json / .txt
   ============================================================ */

const $ = (s) => document.querySelector(s);

const els = {
  statWorkers: $('#stat-workers'),
  led: $('#led-socket'),
  workers: $('#workers-list'),
  workersEmpty: $('#workers-empty'),
  cards: $('#cards'),
  form: $('#test-form'),
  script: $('#script'),
  totalVus: $('#total-vus'),
  duration: $('#duration'),
  btnStart: $('#btn-start'),
  btnStop: $('#btn-stop'),
  formStatus: $('#form-status'),
  metricSelect: $('#metric-select'),
  metricRow: $('#metric-row'),
  metricNote: $('#metric-note'),
  logsTabs: $('#logs-tabs'),
  logview: $('#logview'),
  logPre: $('#log-pre'),
  logCount: $('#log-count'),
  autoScroll: $('#auto-scroll'),
  btnClear: $('#btn-clear'),
  sessionSelect: $('#session-select'),
  rawWorkerSelect: $('#raw-worker-select'),
  reportMeta: $('#report-meta'),
  btnReportJson: $('#btn-report-json'),
  btnReportTxt: $('#btn-report-txt'),
  btnReportRaw: $('#btn-report-raw')
};

const DEFAULT_SCRIPT = [
  "import http from 'k6/http';",
  "import { check, sleep } from 'k6';",
  '',
  'export default function () {',
  "  const res = http.get('https://k6.io');",
  "  check(res, {",
  "    'status est 200': (r) => r.status === 200",
  '  });',
  '  sleep(1);',
  '}'
].join('\n');

els.script.value = DEFAULT_SCRIPT;

/* ---------- Constantes & état ---------- */

const HISTORY_MAX = 1800;     // snapshots par seconde conservés côté client
const MAX_LOG_KEEP = 5000;   // lignes conservées par worker (mémoire)
const MAX_DOM_LINES = 3000;  // lignes rendues dans le DOM de la vue de logs
const SPARK_LEN = 120;      // points des sparklines des cartes

let rows = [];              // snapshots (ui:metrics) de la session affichée
let sessionSummaries = []; // dernier /api/test/sessions (pour le JSON brut par worker)
let activeSessionId = null;    // session affichée (graphiques + logs)
let userPinnedId = null;      // session choisie dans le sélecteur « Rapport » (ne pas être détaché)
let maxSeq = 0;             // dédoublonnage du rejeu
let activeWorker = null;    // onglet de logs sélectionné
let totalLogLines = 0;
let stick = true;

/* ---------- Petits utilitaires ---------- */

const pad = (n, l = 2) => String(n).padStart(l, '0');

const fmtTs = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const fmtInt = (v) => (v == null ? '—' : Math.round(v).toLocaleString('fr-FR'));
const fmtNum = (v) => (v == null ? '—' : Number(v).toFixed(2));
const fmtPct = (v) => (v == null ? '—' : v.toFixed(2) + ' %');

function fmtBytesRate(v) {
  if (v == null) return '—';
  if (v < 1000) return `${Math.round(v)} B/s`;
  if (v < 1e6) return `${(v / 1e3).toFixed(1)} kB/s`;
  return `${(v / 1e6).toFixed(2)} MB/s`;
}

function nearBottom() {
  return els.logview.scrollHeight - els.logview.scrollTop - els.logview.clientHeight < 80;
}

function scrollBottom() {
  els.logview.scrollTop = els.logview.scrollHeight;
}

/* ---------- Moteur de dessin (canvas, sans dépendance) ---------- */

function prep(canvas) {
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

function niceMax(v) {
  if (!isFinite(v) || v <= 0) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  const d = v / e;
  return (d <= 1 ? 1 : d <= 2 ? 2 : d <= 5 ? 5 : 10) * e;
}

function axisLabel(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v % 1 ? v.toFixed(1) : String(v);
}

// valuesBySeries : tableau de tableaux (un par série), indexé par le temps.
function drawLines(canvas, seriesDef, valuesBySeries) {
  const { ctx, w, h } = prep(canvas);
  const padT = 6, padB = 16, padL = 8, padR = 8;
  const iw = w - padL - padR;
  const ih = h - padT - padB;

  // Grille horizontale
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
    ctx.fillText('en attente de données…', w / 2, h / 2);
    return;
  }

  let max = 0;
  for (const arr of valuesBySeries) for (const v of arr) if (v > max) max = v;
  const top = niceMax(max || 1);

  // Graduations
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
    ctx.stroke();
  });
}

function drawSpark(canvas, values, color) {
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

/* ---------- Graphiques principaux ---------- */

const chartDefs = [
  {
    canvas: $('#chart-http'),
    gets: [(r) => r.rates.httpReq, (r) => r.rates.httpFailed],
    colors: ['#46e5b1', '#ff5c5c'],
    fill: 'rgba(70,229,177,0.10)'
  },
  {
    canvas: $('#chart-data'),
    gets: [(r) => r.rates.dataReceived, (r) => r.rates.dataSent],
    colors: ['#5eb1ff', '#ffb224'],
    fill: 'rgba(94,177,255,0.10)'
  },
  {
    canvas: $('#chart-vus'),
    gets: [(r) => r.vus.current],
    colors: ['#46e5b1'],
    fill: 'rgba(70,229,177,0.14)'
  },
  {
    canvas: $('#chart-checks'),
    gets: [(r) => (r.checks && r.checks.pct != null ? r.checks.pct : 0)],
    colors: ['#46e5b1'],
    fill: 'rgba(70,229,177,0.14)'
  }
];

function drawCharts() {
  for (const c of chartDefs) {
    const vals = c.gets.map((g) => rows.map(g));
    const series = c.gets.map((g, i) => ({ color: c.colors[i], fill: i === 0 ? c.fill : null }));
    drawLines(c.canvas, series, vals);
  }
  drawMetricChart();
}

function drawMetricChart() {
  const canvas = $('#chart-metric');
  const name = els.metricSelect.value;
  if (!name) {
    prep(canvas);
    return;
  }
  const avg = rows.map((r) => (r.metrics[name] ? r.metrics[name].avg : 0) || 0);
  const p95 = rows.map((r) => (r.metrics[name] ? r.metrics[name].p95 : 0) || 0);
  drawLines(canvas, [
    { color: '#46e5b1', fill: 'rgba(70,229,177,0.10)' },
    { color: '#ffb224', fill: null }
  ], [avg, p95]);
}
/* ---------- Cartes de synthèse (façon dashboard k6) ---------- */

const CARDS = [
  { label: 'VUS', get: (r) => r.vus.current, fmt: fmtInt, spark: (r) => r.vus.current, color: '#46e5b1' },
  { label: 'HTTP req/s', get: (r) => r.rates.httpReq, fmt: fmtInt, spark: (r) => r.rates.httpReq, color: '#46e5b1' },
  { label: 'Échecs /s', get: (r) => r.rates.httpFailed, fmt: fmtInt, spark: (r) => r.rates.httpFailed, color: '#ff5c5c', neg: true },
  { label: 'Checks passés', get: (r) => (r.checks ? r.checks.pct : null), fmt: fmtPct, spark: (r) => (r.checks && r.checks.pct != null ? r.checks.pct : 0), color: '#46e5b1' },
  { label: 'Itérations /s', get: (r) => r.rates.iterations, fmt: fmtInt, spark: (r) => r.rates.iterations, color: '#46e5b1' },
  { label: 'Données reçues', get: (r) => r.rates.dataReceived, fmt: fmtBytesRate, spark: (r) => r.rates.dataReceived, color: '#5eb1ff' },
  { label: 'Données envoyées', get: (r) => r.rates.dataSent, fmt: fmtBytesRate, spark: (r) => r.rates.dataSent, color: '#ffb224' }
];

function buildCards() {
  els.cards.replaceChildren(...CARDS.map((c) => {
    const card = document.createElement('div');
    card.className = 'card';
    const label = document.createElement('span');
    label.className = 'card-label';
    label.textContent = c.label;
    const value = document.createElement('span');
    value.className = 'card-value';
    value.textContent = '—';
    const cv = document.createElement('canvas');
    card.append(label, value, cv);
    c.valueEl = value;
    c.sparkCanvas = cv;
    return card;
  }));
}

function updateCards() {
  const r = rows[rows.length - 1];
  const vals = rows.slice(-SPARK_LEN);
  for (const c of CARDS) {
    c.valueEl.textContent = r ? c.fmt(c.get(r)) : '—';
    if (c.neg) c.valueEl.classList.toggle('neg', r ? c.get(r) > 0 : false);
    drawSpark(c.sparkCanvas, vals.map((row) => (c.spark(row) == null ? 0 : c.spark(row))), c.color);
  }
}

/* ---------- Explorateur de métrique ---------- */

function knownMetrics() {
  const out = [];
  for (const r of rows) for (const k of Object.keys(r.metrics)) if (!out.includes(k)) out.push(k);
  return out;
}

function syncMetricSelect() {
  const cur = els.metricSelect.value;
  const names = knownMetrics();
  const frag = document.createDocumentFragment();
  if (!names.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(en attente de données)';
    frag.appendChild(o);
  } else {
    for (const n of names) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      frag.appendChild(o);
    }
  }
  els.metricSelect.replaceChildren(frag);
  els.metricSelect.value = names.includes(cur) ? cur : names[0] || '';
}

function updateMetricTable() {
  const name = els.metricSelect.value;
  const r = rows[rows.length - 1];
  const st = name && r ? r.metrics[name] : null;
  const tds = els.metricRow.children;
  if (!st) {
    for (const td of tds) td.textContent = '—';
    els.metricNote.textContent = 'Pas encore de points pour cette métrique.';
    return;
  }
  const fmts = [fmtInt, fmtInt, fmtNum, fmtNum, fmtNum, fmtNum, fmtNum, fmtNum, fmtNum, fmtNum];
  const vals = [st.count, st.rate, st.avg, st.p70, st.p80, st.p90, st.p95, st.p99, st.min, st.max];
  tds.forEach((td, i) => { td.textContent = fmts[i](vals[i]); });
  els.metricNote.textContent =
    `Métrique « ${name} » — percentiles recalculés sur les ${Math.min(rows.length, 5000)} derniers points.`;
}

/* ---------- Logs par worker (pas de concaténation) ---------- */

const workerLogs = new Map(); // workerId -> [ { t, type, text } ]
const tabs = new Map();       // workerId -> élément d'onglet

function makeLineEl(l, animate) {
  const div = document.createElement('div');
  div.className = 'ln-log' + (l.type === 'stderr' ? ' err' : '') + (animate ? '' : ' fast');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = fmtTs(l.t);
  const x = document.createElement('span');
  x.className = 'x';
  x.textContent = `[${l.type.toUpperCase()}] ${l.text}`;
  div.append(t, x);
  return div;
}

function ensureTab(id) {
  let tab = tabs.get(id);
  if (tab) return tab;
  tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'logtab';
  const name = document.createElement('span');
  name.className = 'wname';
  name.textContent = id;
  const n = document.createElement('span');
  n.className = 'tab-n';
  n.textContent = '0';
  tab.append(name, n);
  tab.addEventListener('click', () => selectWorker(id));
  els.logsTabs.appendChild(tab);
  tabs.set(id, tab);
  return tab;
}

function rebuildLogPre() {
  const arr = (activeWorker && workerLogs.get(activeWorker)) || [];
  const view = arr.slice(-MAX_DOM_LINES);
  const frag = document.createDocumentFragment();
  for (const l of view) frag.appendChild(makeLineEl(l, false));
  els.logPre.replaceChildren(frag);
  els.logview.classList.toggle('is-empty', arr.length === 0);
}

function selectWorker(id) {
  activeWorker = id;
  for (const [wid, tab] of tabs) tab.classList.toggle('active', wid === id);
  rebuildLogPre();
  scrollBottom();
}

function appendLogLine(entry) {
  const { workerId, t, type, text } = entry;
  let arr = workerLogs.get(workerId);
  if (!arr) {
    arr = [];
    workerLogs.set(workerId, arr);
  }
  arr.push({ t, type, text });
  if (arr.length > MAX_LOG_KEEP) arr.shift();
  totalLogLines++;
  const tab = ensureTab(workerId);
  tab.querySelector('.tab-n').textContent = String(arr.length);
  els.logCount.textContent = totalLogLines.toLocaleString('fr-FR');

  // Première ligne d'un worker non encore suivi : on l'active automatiquement
  if (!activeWorker) {
    selectWorker(workerId);
    return;
  }
  if (workerId !== activeWorker) return;
  els.logPre.appendChild(makeLineEl({ t, type, text }, true));
  els.logview.classList.remove('is-empty');
  while (els.logPre.childElementCount > MAX_DOM_LINES) {
    els.logPre.firstElementChild.remove();
  }
  if (els.autoScroll.checked && stick) scrollBottom();
}

function resetAll() {
  rows = [];
  maxSeq = 0;
  activeWorker = null;
  totalLogLines = 0;
  workerLogs.clear();
  els.logsTabs.replaceChildren();
  tabs.clear();
  els.logPre.replaceChildren();
  els.logview.classList.add('is-empty');
  els.logCount.textContent = '0';
  syncMetricSelect();
  updateMetricTable();
  drawCharts();
  updateCards();
}
/* ---------- Liste des workers ---------- */

function renderWorkers(list) {
  list = list || [];
  els.statWorkers.textContent = String(list.length);
  if (list.length) els.workersEmpty.remove();
  const frag = document.createDocumentFragment();
  for (const w of list) {
    const li = document.createElement('li');
    li.className = 'worker';
    const name = document.createElement('span');
    name.className = 'wname';
    name.textContent = w.id;
    const busy = w.status === 'BUSY';
    const b = document.createElement('span');
    b.className = 'badge ' + (busy ? 'busy' : 'ok');
    const dot = document.createElement('i');
    dot.className = 'dot';
    b.append(dot, document.createTextNode(busy ? 'Occupé' : 'Disponible'));
    li.append(name, b);
    frag.appendChild(li);
  }
  els.workers.replaceChildren(frag);
  if (!list.length) els.workers.prepend(els.workersEmpty);
}

/* ---------- Sessions & rapports ---------- */

function syncReportButtons() {
  const has = !!els.sessionSelect.value;
  els.btnReportJson.disabled = !has;
  els.btnReportTxt.disabled = !has;
  els.rawWorkerSelect.disabled = !has;
  els.btnReportRaw.disabled = !has || !els.rawWorkerSelect.value;
}

function syncRawWorkerSelect() {
  const sid = els.sessionSelect.value;
  const s = sessionSummaries.find((x) => x.id === sid);
  const ids = (s && s.workerIds) || [];
  const frag = document.createDocumentFragment();
  if (!ids.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(aucun worker ciblé)';
    frag.appendChild(o);
  } else {
    for (const w of ids) {
      const o = document.createElement('option');
      o.value = w;
      o.textContent = w;
      frag.appendChild(o);
    }
  }
  els.rawWorkerSelect.replaceChildren(frag);
  els.rawWorkerSelect.value = ids[0] || '';
  syncReportButtons();
}

function setLatest(s) {
  if (!s) {
    els.reportMeta.textContent = 'Aucune session';
    els.btnReportJson.disabled = true;
    els.btnReportTxt.disabled = true;
    return;
  }
  els.reportMeta.textContent =
    `${s.overall} · ${s.totalVus} VUs · ${s.workers.length} worker(s) · ${s.duration}`;
  syncReportButtons();
}

function fillSelect(list, forceId) {
  sessionSummaries = list || [];
  const cur = els.sessionSelect.value;
  const frag = document.createDocumentFragment();
  for (const s of sessionSummaries) {
    const o = document.createElement('option');
    o.value = s.id;
    const date = new Date(s.createdAt).toLocaleString('fr-FR');
    o.textContent = `${s.id} — ${s.overall} · ${s.totalVus} VUs · ${s.workerCount}w · ${date}`;
    frag.appendChild(o);
  }
  els.sessionSelect.replaceChildren(frag);
  const validCur = sessionSummaries.some((x) => x.id === cur) ? cur : '';
  els.sessionSelect.value = forceId || validCur || (sessionSummaries[0] ? sessionSummaries[0].id : '');
  syncRawWorkerSelect();
}

async function refreshSessions(forceId) {
  try {
    const res = await fetch('/api/test/sessions');
    if (!res.ok) throw new Error();
    fillSelect(await res.json(), forceId);
  } catch {
    /* orchestrateur momentanément injoignable */
  }
}

function downloadReport(fmt) {
  const id = els.sessionSelect.value;
  if (!id) return;
  const a = document.createElement('a');
  a.href = `/api/test/report?session=${encodeURIComponent(id)}&format=${fmt}`;
  a.download = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// JSON brut k6 d'un worker (contenu du `--out json=`, une ligne JSON par point)
function downloadRaw() {
  const sid = els.sessionSelect.value;
  const wid = els.rawWorkerSelect.value;
  if (!sid || !wid) return;
  const a = document.createElement('a');
  a.href = `/api/raw-metrics?session=${encodeURIComponent(sid)}&worker=${encodeURIComponent(wid)}`;
  a.download = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------- Socket temps réel ---------- */

const socket = io();

socket.on('connect', () => els.led.classList.add('on'));
socket.on('disconnect', () => els.led.classList.remove('on'));

function applySessionState(s) {
  if (!s) return;
  const hijack = s.status === 'RUNNING' && s.id !== activeSessionId;
  if (hijack) {
    // Un nouveau test repart : la vue repasse dessus (même si l'utilisateur
    // regardait une autre session).
    userPinnedId = null;
    activeSessionId = s.id;
    resetAll();
  }
  setLatest(s);
  refreshSessions(hijack ? s.id : undefined);
}

socket.on('ui:state', ({ workers, session, latestSession, sessions }) => {
  renderWorkers(workers);
  if (session) applySessionState(session);
  setLatest(latestSession);
  fillSelect(sessions);
});

// Rejeu des logs déjà produits (connexion en retard, ou session sélectionnée dans le bandeau « Rapport »)
socket.on('ui:logs_replay', ({ session, workers }) => {
  if (session !== activeSessionId) {
    // Bascule de la vue vers la session demandée
    activeSessionId = session;
    resetAll();
  }
  let first = null;
  let m = 0;
  for (const [id, lines] of Object.entries(workers)) {
    if (!first) first = id;
    const clean = lines.map((l) => ({ t: l.t, type: l.type, text: l.text }));
    workerLogs.set(id, clean);
    for (const l of lines) if (l.seq) m = Math.max(m, l.seq);
    const tab = ensureTab(id);
    tab.querySelector('.tab-n').textContent = String(clean.length);
  }
  maxSeq = Math.max(maxSeq, m);
  totalLogLines = [...workerLogs.values()].reduce((a, l) => a + l.length, 0);
  els.logCount.textContent = totalLogLines.toLocaleString('fr-FR');
  if (first) selectWorker(first);
});

socket.on('ui:log', (l) => {
  if (l.session !== activeSessionId) return;
  if (l.seq && l.seq <= maxSeq) return; // déjà rejouée
  if (l.seq) maxSeq = l.seq;
  appendLogLine(l);
});

// Snapshots de métriques (rejeu à la demande puis 1/s pendant le test)
socket.on('ui:metrics_replay', ({ session, rows: replayRows }) => {
  if (session !== activeSessionId) {
    activeSessionId = session;
    resetAll();
  }
  rows = replayRows || [];
  syncMetricSelect();
  updateMetricTable();
  drawCharts();
  updateCards();
});

socket.on('ui:metrics', ({ session, running, row }) => {
  if (session !== activeSessionId) {
    // Le snapshot ne correspond pas à la session affichée :
    //  - si l'utilisateur a choisi une session dans le sélecteur « Rapport »,
    //    on reste dessus (pas de rattrapage automatique) ;
    //  - sinon c'est le flux live du test en cours : on (re)bascule dessus,
    //    même si l'état de démarrage a été manqué (reconnexion, etc.).
    if (running && userPinnedId === null) {
      activeSessionId = session;
      resetAll();
      refreshSessions(session);
    } else {
      return;
    }
  }
  rows.push(row);
  if (rows.length > HISTORY_MAX) rows.shift();
  syncMetricSelect();
  updateMetricTable();
  drawCharts();
  updateCards();
});

socket.on('ui:workers', renderWorkers);
socket.on('ui:session_state', applySessionState);

/* ---------- Contrôles ---------- */

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.btnStart.disabled = true;
  els.formStatus.className = 'form-status';
  els.formStatus.textContent = 'Envoi…';
  try {
    const res = await fetch('/api/test/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scriptContent: els.script.value,
        totalVus: Math.max(1, parseInt(els.totalVus.value, 10) || 1),
        duration: els.duration.value.trim() || '30s'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // La vue bascule immédiatement sur la nouvelle session, sans attendre l'état socket
    userPinnedId = null;
    activeSessionId = data.sessionId;
    resetAll();
    refreshSessions(data.sessionId);
    els.formStatus.className = 'form-status ok';
    els.formStatus.textContent = `Test lancé — ${data.workersCibles} worker(s) ciblé(s), session ${data.sessionId}.`;
  } catch (err) {
    els.formStatus.className = 'form-status err';
    els.formStatus.textContent = err.message;
  } finally {
    els.btnStart.disabled = false;
  }
});

els.btnStop.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/test/stop', { method: 'POST' });
    const data = await res.json();
    els.formStatus.className = 'form-status ok';
    els.formStatus.textContent = data.message;
  } catch {
    els.formStatus.className = 'form-status err';
    els.formStatus.textContent = "Impossible d'envoyer l'ordre d'arrêt.";
  }
});

els.btnClear.addEventListener('click', () => {
  els.logPre.replaceChildren();
  els.logview.classList.add('is-empty');
});

els.sessionSelect.addEventListener('change', () => {
  // Changer de session = revoir les graphiques/logs de cette session
  const id = els.sessionSelect.value;
  userPinnedId = id || null;
  if (id) socket.emit('ui:show_session', { session: id });
  syncReportButtons();
  syncRawWorkerSelect();
});
els.rawWorkerSelect.addEventListener('change', syncReportButtons);
els.metricSelect.addEventListener('change', () => {
  drawMetricChart();
  updateMetricTable();
});

els.logview.addEventListener('scroll', () => {
  stick = nearBottom();
});

els.autoScroll.addEventListener('change', () => {
  if (els.autoScroll.checked) {
    stick = true;
    scrollBottom();
  }
});

els.btnReportJson.addEventListener('click', () => downloadReport('json'));
els.btnReportTxt.addEventListener('click', () => downloadReport('txt'));
els.btnReportRaw.addEventListener('click', downloadRaw);

/* ---------- Init ---------- */

buildCards();
syncMetricSelect();
updateMetricTable();
drawCharts();
updateCards();
refreshSessions();

window.addEventListener('resize', () => {
  drawCharts();
  updateCards();
});
