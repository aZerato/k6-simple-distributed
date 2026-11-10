/* ============================================================
   k6 Orchestrator — Console web (app.js)
   - Abonnement socket.io : flux de logs concaténé en direct
   - Lancement / arrêt des tests
   - Téléchargement du rapport (.txt)
   ============================================================ */

const $ = (s) => document.querySelector(s);

const els = {
  workers: $('#workers-list'),
  workersEmpty: $('#workers-empty'),
  statWorkers: $('#stat-workers'),
  led: $('#led-socket'),
  logview: $('#logview'),
  logPre: $('#logview-pre'),
  logCount: $('#log-count'),
  sessionBadge: $('#session-badge'),
  sessionBadgeText: $('#session-badge-text'),
  sessionId: $('#session-id'),
  autoScroll: $('#auto-scroll'),
  btnClear: $('#btn-clear'),
  form: $('#test-form'),
  script: $('#script'),
  totalVus: $('#total-vus'),
  duration: $('#duration'),
  btnStart: $('#btn-start'),
  btnStop: $('#btn-stop'),
  formStatus: $('#form-status'),
  sessionSelect: $('#session-select'),
  reportMeta: $('#report-meta'),
  btnReport: $('#btn-report')
};

const DEFAULT_SCRIPT = [
  "import http from 'k6/http';",
  "import { sleep } from 'k6';",
  '',
  'export default function () {',
  "  http.get('https://k6.io');",
  '  sleep(1);',
  '}'
].join('\n');

els.script.value = DEFAULT_SCRIPT;

const MAX_DOM_LINES = 3000;
let domLines = 0;
let lineCount = 0;
let maxSeq = 0;
let sessionId = null; // session affichée dans la vue de logs
let stick = true;

/* ---------- Petits utilitaires ---------- */

const pad = (n, l = 2) => String(n).padStart(l, '0');

const fmtTs = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

function workerClass(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `w-${h % 6}`;
}

function makeLineEl(l, animate) {
  const div = document.createElement('div');
  div.className = 'ln' + (animate ? '' : ' fast');
  const span = (cls, txt) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = txt;
    return s;
  };
  div.append(
    span('t', fmtTs(l.t)),
    span('w ' + workerClass(l.workerId), l.workerId),
    span('k' + (l.type === 'stderr' ? ' k-err' : ''), l.type.toUpperCase()),
    span('x', l.text)
  );
  return div;
}

function nearBottom() {
  return els.logview.scrollHeight - els.logview.scrollTop - els.logview.clientHeight < 80;
}

function scrollBottom() {
  els.logview.scrollTop = els.logview.scrollHeight;
}

function updateEmpty() {
  els.logview.classList.toggle('is-empty', lineCount === 0);
}

function updateCount() {
  els.logCount.textContent = lineCount.toLocaleString('fr-FR');
}

function resetLogView(id) {
  sessionId = id;
  maxSeq = 0;
  lineCount = 0;
  domLines = 0;
  els.logPre.replaceChildren();
  updateCount();
  els.sessionId.textContent = id || '—';
  updateEmpty();
}

/* ---------- Rendu des logs ---------- */

function appendLine(l, animate) {
  els.logPre.appendChild(makeLineEl(l, animate));
  domLines++;
  if (domLines > MAX_DOM_LINES) {
    if (els.logPre.firstChild) els.logPre.firstChild.remove();
    domLines--;
  }
  lineCount++;
  updateCount();
  if (els.autoScroll.checked && stick) scrollBottom();
  updateEmpty();
}

/* ---------- Workers ---------- */

function renderWorkers(list) {
  list = list || [];
  els.statWorkers.textContent = String(list.length);
  els.workersEmpty.style.display = list.length ? 'none' : '';
  els.workers.replaceChildren(...list.map((w) => {
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
    return li;
  }));
}

/* ---------- Session & rapport ---------- */

function setLatest(s) {
  if (!s) {
    els.reportMeta.textContent = 'Aucune session';
    if (!els.sessionSelect.value) els.btnReport.disabled = true;
    return;
  }
  els.btnReport.disabled = false;
  els.reportMeta.textContent =
    `${s.duration} · ${s.totalVus} VUs · ${s.workers.length} worker(s) · ${s.linesCount.toLocaleString('fr-FR')} lignes`;
}

function fillSelect(list) {
  const cur = els.sessionSelect.value;
  els.sessionSelect.replaceChildren(...list.map((s) => {
    const o = document.createElement('option');
    o.value = s.id;
    const date = new Date(s.createdAt).toLocaleString('fr-FR');
    o.textContent = `${s.id} — ${s.overall} (${date})`;
    return o;
  }));
  els.sessionSelect.value = cur || (list[0] && list[0].id) || '';
  if (!els.sessionSelect.value) els.btnReport.disabled = true;
}

async function refreshSessions() {
  try {
    const res = await fetch('/api/test/sessions');
    if (!res.ok) throw new Error();
    fillSelect(await res.json());
  } catch {
    /* orchestrateur momentanément injoignable */
  }
}

/* ---------- Socket temps réel ---------- */

const socket = io();

socket.on('connect', () => els.led.classList.add('on'));
socket.on('disconnect', () => els.led.classList.remove('on'));

socket.on('ui:state', ({ workers, session, latestSession, sessions }) => {
  renderWorkers(workers);
  if (session && session.status === 'RUNNING') {
    resetLogView(session.id);
    els.sessionBadge.className = 'badge running';
    els.sessionBadgeText.textContent = 'En cours';
  }
  setLatest(latestSession);
  fillSelect(sessions);
});

// Rejeu des lignes déjà produites (connexion en retard pendant un test)
socket.on('ui:logs_bulk', ({ session, lines }) => {
  if (session !== sessionId) return;
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    frag.appendChild(makeLineEl(l, false));
    domLines++;
    lineCount++;
    if (l.seq) maxSeq = Math.max(maxSeq, l.seq);
  }
  els.logPre.appendChild(frag);
  updateCount();
  updateEmpty();
  scrollBottom();
});

// Nouvelle ligne du flux concaténée
socket.on('ui:log', (l) => {
  if (l.session !== sessionId) return;
  if (l.seq && l.seq <= maxSeq) return; // déjà rejouée
  maxSeq = l.seq;
  appendLine(l, true);
});

socket.on('ui:workers', renderWorkers);

socket.on('ui:session_state', (s) => {
  if (s.status === 'RUNNING' && s.id !== sessionId) {
    resetLogView(s.id);
  }
  if (s.status === 'RUNNING') {
    els.sessionBadge.className = 'badge running';
    els.sessionBadgeText.textContent = 'En cours';
  } else {
    const cls = s.overall === 'SUCCÈS' ? 'ok' : s.overall === 'EN COURS' ? 'idle' : 'err';
    els.sessionBadge.className = 'badge ' + cls;
    els.sessionBadgeText.textContent = `Terminé — ${s.overall}`;
  }
  setLatest(s);
  refreshSessions();
});

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
  domLines = 0;
  lineCount = 0;
  updateCount();
  updateEmpty();
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

els.btnReport.addEventListener('click', () => {
  const id = els.sessionSelect.value;
  if (!id) return;
  const a = document.createElement('a');
  a.href = `/api/test/report?session=${encodeURIComponent(id)}`;
  a.download = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

/* ---------- Init ---------- */

updateEmpty();
refreshSessions();
