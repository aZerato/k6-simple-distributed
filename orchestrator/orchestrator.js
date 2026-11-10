import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// --- LIMITES MÉMOIRE / CONSOLE ---
const MAX_SESSIONS = 10;               // sessions conservées (plus récentes d'abord)
const MAX_LOG_LINES_PER_WORKER = 5000; // lignes de logs conservées par worker / session
const RING_CAPACITY = 5000;            // valeurs récentes conservées par métrique (percentiles)
const MAX_HISTORY_ROWS = 1800;         // snapshots par seconde conservés par session
const MAX_RAW_LINES_PER_WORKER = 200000; // lignes du JSON brut k6 conservées par worker

const app = express();
const httpServer = createServer(app);
// Configuration de Socket.io avec CORS ouvert pour laisser les workers se connecter
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
// Console web de l'orchestrateur (fichiers statiques)
app.use(express.static(path.join(__dirname, 'public')));

// --- REGISTRE & SESSIONS ---
// Registre en mémoire pour suivre l'état de nos workers
const workersRegistry = new Map();
const sessions = [];
let currentSession = null;

// --- UTILITAIRES ---
function pad(n, l = 2) { return String(n).padStart(l, '0'); }

function stamp(d) {
  const dt = new Date(d);
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}.${pad(dt.getMilliseconds(), 3)}`;
}

function dateFr(d) {
  const dt = new Date(d);
  return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${stamp(dt)}`;
}

function fmtBytes(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a < 1000) return `${Math.round(v)} B`;
  if (a < 1e6) return `${(v / 1e3).toFixed(1)} kB`;
  if (a < 1e9) return `${(v / 1e6).toFixed(1)} MB`;
  return `${(v / 1e9).toFixed(1)} GB`;
}

function sessionOverallStatus(session) {
  if (session.status === 'RUNNING') return 'EN COURS';
  const entries = [...session.workers.values()];
  if (entries.some((e) => e.error)) return 'INTERROMPU';
  if (entries.some((e) => e.exitCode !== 0)) return 'ÉCHEC';
  return 'SUCCÈS';
}

function workersList() {
  return [...workersRegistry.values()].map((w) => ({ id: w.id, status: w.status }));
}

function broadcastWorkers() {
  io.to('dashboard').emit('ui:workers', workersList());
}

function broadcastSession(session) {
  io.to('dashboard').emit('ui:session_state', sessionState(session));
}

function sessionState(session) {
  return {
    id: session.id,
    status: session.status,
    overall: sessionOverallStatus(session),
    createdAt: session.createdAt.toISOString(),
    finishedAt: session.finishedAt ? session.finishedAt.toISOString() : null,
    totalVus: session.totalVus,
    duration: session.duration,
    workerIds: [...session.workers.keys()],
    rawTruncated: session.rawTruncated,
    workers: [...session.workers.entries()].map(([id, w]) => ({
      id,
      exitCode: w.exitCode,
      finishedAt: w.finishedAt ? w.finishedAt.toISOString() : null,
      error: w.error
    }))
  };
}

function sessionsSummary() {
  return sessions.map((s) => ({
    id: s.id,
    status: s.status,
    overall: sessionOverallStatus(s),
    createdAt: s.createdAt.toISOString(),
    finishedAt: s.finishedAt ? s.finishedAt.toISOString() : null,
    totalVus: s.totalVus,
    duration: s.duration,
    workerCount: s.workers.size,
    workerIds: [...s.workers.keys()],
    rawTruncated: s.rawTruncated,
    vusMax: vusOf(s) ? (s.metrics.get('vus') ? s.metrics.get('vus').max : 0) : 0
  }));
}

function vusOf(s) { return s.metrics.get('vus'); }

// --- AGRÉGATION DES MÉTRIQUES k6 (stream `worker:metrics`) ---
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

function aggStats(agg) {
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
function ingestMetrics(workerId, items) {
  const s = currentSession;
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
    let agg = s.metrics.get(item.metric);
    if (!agg) {
      agg = new MetricAgg();
      s.metrics.set(item.metric, agg);
    }
    const count = Math.max(1, item.data.count || 1);
    agg.ingest(Number(item.data.value) || 0, count);
  }
}
// --- SESSIONS : CRÉATION, LOGS PAR WORKER, SNAPSHOTS ---
function createSession({ totalVus, duration }) {
  const session = {
    id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'RUNNING',
    createdAt: new Date(),
    finishedAt: null,
    totalVus,
    duration,
    workers: new Map(),   // workerId -> { exitCode, finishedAt, error }
    pending: {},           // workerId -> fragment de log non terminé
    workerLogs: new Map(),// workerId -> [ { t, type, text, seq } ]
    metrics: new Map(),   // metric name -> MetricAgg
    rawMetrics: new Map(), // workerId -> [ ligne JSON brute (format `--out json=` k6) ]
    rawTruncated: false,  // le buffer brut a-t-il été tronqué (plafond mémoire) ?
    history: [],           // snapshots par seconde
    seq: 0
  };
  sessions.unshift(session);
  if (sessions.length > MAX_SESSIONS) sessions.pop();
  currentSession = session;
  return session;
}

// Ajoute une ligne de log du worker et la diffuse vers la console
function pushWorkerLine(workerId, type, text) {
  const s = currentSession;
  if (!s || s.status !== 'RUNNING') return;
  const arr = s.workerLogs.get(workerId) || s.workerLogs.set(workerId, []).get(workerId);
  const t = new Date();
  const entry = { t: t.toISOString(), type, text, seq: ++s.seq };
  arr.push(entry);
  if (arr.length > MAX_LOG_LINES_PER_WORKER) arr.shift();
  io.to('dashboard').emit('ui:log', {
    session: s.id,
    workerId,
    type,
    text,
    t: entry.t,
    seq: entry.seq
  });
}

// Incrémente le tampon de ligne du worker puis pousse les lignes complètes
function ingestLog(workerId, type, output) {
  const s = currentSession;
  if (!s || s.status !== 'RUNNING') return;
  let buf = (s.pending[workerId] || '') + output;
  const parts = buf.split(/[\r\n]+/);
  // Le dernier fragment est potentiellement incomplet : on le conserve
  s.pending[workerId] = parts.pop();
  for (const text of parts) pushWorkerLine(workerId, type, text);
}

function markWorkerFinished(workerId, { exitCode = null, error = null } = {}) {
  const session = sessions.find((s) => s.workers.has(workerId));
  if (!session) return;
  const entry = session.workers.get(workerId);
  if (entry.finishedAt) return; // déjà clôturé (évite les doublons)

  // Flush du dernier fragment de ligne non terminé de ce worker
  const rest = session.pending[workerId];
  session.pending[workerId] = '';
  if (rest) pushWorkerLine(workerId, 'stdout', rest);

  entry.exitCode = exitCode;
  entry.error = error || null;
  entry.finishedAt = new Date();

  if (session.status === 'RUNNING' && [...session.workers.values()].every((e) => e.finishedAt)) {
    session.status = 'FINISHED';
    session.finishedAt = new Date();
  }
  if (currentSession === session && session.status === 'FINISHED') {
    currentSession = sessions.find((s) => s.status === 'RUNNING') || null;
  }

  broadcastSession(session);
  broadcastWorkers();
  console.log(`[Orchestrateur] Worker ${workerId} : ${entry.error ? `erreur (${entry.error})` : `code de sortie ${entry.exitCode}`}`);
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

  // Taux sur la dernière seconde
  for (const agg of s.metrics.values()) {
    agg.rate = agg.rateSum;
    agg.rateSum = 0;
  }

  const row = {
    t: new Date().toISOString(),
    vus: { current: vus ? vus.last : 0, max: vus ? vus.max : 0 },
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
  for (const [name, agg] of s.metrics) row.metrics[name] = aggStats(agg);

  s.history.push(row);
  if (s.history.length > MAX_HISTORY_ROWS) s.history.shift();
  return row;
}

// Un snapshot par seconde tant qu'une session est en cours
setInterval(() => {
  const s = currentSession;
  if (!s || s.status !== 'RUNNING') return;
  const row = buildRow(s);
  // `running: true` = flux live du test en cours (la console s'y rattache d'office)
  io.to('dashboard').emit('ui:metrics', { session: s.id, running: true, row });
}, 1000);
// --- RAPPORTS (JSON + TXT) ---
function slimRow(r) {
  const m = {};
  for (const [k, v] of Object.entries(r.metrics)) {
    m[k] = {
      count: v.count,
      rate: v.rate,
      avg: v.avg,
      min: v.min,
      max: v.max,
      p70: v.p70,
      p80: v.p80,
      p90: v.p90,
      p95: v.p95,
      p99: v.p99
    };
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
    metrics: m
  };
}

function finalStats(s) {
  const out = {};
  for (const [name, agg] of s.metrics) out[name] = aggStats(agg);
  return out;
}

function buildJsonReport(s) {
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
    totals: {
      vusMax: vus ? vus.max : 0,
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

function buildTxtReport(s) {
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
// Un script k6 ne peut importer que des modules k6 (k6, k6/metrics, k6/html,
// k6/crypto, k6/csv, k6/experimental/oracle) : tout import de module Node.js
// (fs, path, http, child_process...) fait planter k6 à l'initialisation
// (« The moduleSpecifier "fs" couldn't be recognised as something k6 supports »).
// On le détecte côté orchestrateur pour renvoyer une erreur claire avant
// d'envoyer le script aux workers.
const K6_NODE_BUILTIN_MODULES = ['fs/promises', 'fs/constants', 'fs', 'path/posix', 'path/win32', 'path', 'http2', 'http', 'https', 'os', 'child_process', 'crypto', 'net', 'stream', 'url', 'util', 'zlib', 'events', 'buffer', 'process', 'cluster', 'dgram', 'dns/promises', 'dns', 'readline', 'repl', 'inspector', 'perf_hooks', 'assert', 'async_hooks', 'console', 'diagnostics_channel', 'domain', 'module', 'punycode', 'querystring', 'string_decoder', 'timers', 'tty', 'v8', 'vm', 'worker_threads', 'sea', 'sqlite', 'trace_events', 'wasi'];
const K6_NODE_IMPORT_RE = new RegExp(`(?:require\\s*\\(\\s*|import\\s+(?:[^;\\n]*?\\s+from\\s+)?)(['"])(?:node:)?(${K6_NODE_BUILTIN_MODULES.join('|')})\\1`, 'i');
function findNodeBuiltinImport(script) {
  const m = K6_NODE_IMPORT_RE.exec(script || '');
  return m ? m[2] : null;
}

// --- ENDPOINTS HTTP ---
app.post('/api/test/start', (req, res) => {
  const { scriptContent, scriptPath, totalVus, duration, envVariables } = req.body;

  // Le script est collé (`scriptContent`) ou pointé par un chemin (`scriptPath`) :
  // le fichier .js est lu sur la machine de l'orchestrateur (chemin absolu ou
  // relatif au répertoire de l'orchestrateur) puis injecté tel quel aux workers.
  let content = scriptContent;
  const p = typeof scriptPath === 'string' ? scriptPath.trim() : '';
  if (p) {
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      const code = e && e.code;
      const msg = code === 'ENOENT'
        ? `Fichier de script introuvable : ${p}`
        : `Impossible de lire le fichier de script (${code || (e && e.message)}) : ${p}`;
      return res.status(400).json({ error: msg });
    }
    if (!text.trim()) {
      return res.status(400).json({ error: `Le fichier de script est vide : ${p}` });
    }
    content = text;
  }

  // Import de module Node.js : k6 planterait à l'initialisation (erreur illisible
  // dans les logs du worker) ; on renvoie une explication actionnable ici.
  const nodeBuiltin = findNodeBuiltinImport(content);
  if (nodeBuiltin) {
    return res.status(400).json({
      error: `Le script importe le module Node.js '${nodeBuiltin}' : impossible sous k6 (bac à sable sans API Node.js). Un script k6 ne peut importer que des modules k6 (k6, k6/metrics, k6/html, k6/crypto, k6/csv, k6/experimental/oracle). Pour charger des données, passez-les via les variables d'environnement, via k6/csv (URL) ou en les inlinant dans le script.`
    });
  }

  if (!content || !totalVus || !duration) {
    return res.status(400).json({ error: 'Paramètres manquants (scriptContent ou scriptPath, totalVus, duration).' });
  }

  if (currentSession) {
    return res.status(409).json({
      error: `Un test est déjà en cours (${currentSession.id}). Arrêtez-le d'abord via /api/test/stop.`
    });
  }

  // Filtrer pour obtenir uniquement les workers disponibles
  const availableWorkers = Array.from(workersRegistry.values()).filter((w) => w.status === 'AVAILABLE');

  if (availableWorkers.length === 0) {
    return res.status(422).json({ error: 'Aucun worker disponible pour le moment.' });
  }

  // Distribution équitable des Utilisateurs Virtuels (VUs)
  const workersCount = availableWorkers.length;
  const baseVusPerWorker = Math.floor(totalVus / workersCount);
  const remainderVus = totalVus % workersCount;

  const session = createSession({ totalVus, duration });

  // Envoi de l'ordre de démarrage personnalisé à chaque worker disponible
  availableWorkers.forEach((worker, index) => {
    // Le premier worker récupère le reste de la division s'il y en a un
    const assignedVus = index === 0 ? baseVusPerWorker + remainderVus : baseVusPerWorker;

    if (assignedVus <= 0) return; // Ce worker n'a aucun VU à sa charge : il n'est pas ciblé

    session.workers.set(worker.id, { exitCode: null, finishedAt: null, error: null });
    console.log(`[Orchestrateur] Envoi du sous-test au worker ${worker.id} (${assignedVus} VUs)`);

    io.to(worker.socketId).emit('orchestrator:start_test', {
      scriptContent: content,
      vus: assignedVus,
      duration,
      envVariables: {
        ...envVariables,
        ORCHESTRATOR_WORKER_ID: worker.id
      }
    });
  });

  if (session.workers.size === 0) {
    sessions.shift(); // On jette la session vide
    currentSession = null;
    return res.status(422).json({
      error: 'Répartition impossible : les VUS totales sont inférieures au nombre de workers disponibles.'
    });
  }

  broadcastSession(session);
  broadcastWorkers();
  console.log(`[Orchestrateur] Lancement d'un test distribué sur ${session.workers.size} worker(s) — session ${session.id}`);

  res.json({
    message: 'Test distribué initialisé avec succès',
    sessionId: session.id,
    workersCibles: session.workers.size
  });
});

app.post('/api/test/stop', (req, res) => {
  console.log('[Orchestrateur] Demande d\'arrêt d\'urgence généralisée envoyée à tous les workers.');
  io.emit('orchestrator:stop_test');
  res.json({ message: 'Ordre d\'arrêt envoyé à l\'ensemble du réseau.' });
});

app.get('/api/workers', (req, res) => {
  res.json(Array.from(workersRegistry.values()));
});

app.get('/api/test/sessions', (req, res) => {
  res.json(sessionsSummary());
});

// Renvoie le rapport de la session : JSON (séries + stats + logs) ou TXT (résumé)
app.get('/api/test/report', (req, res) => {
  const id = req.query.session;
  const fmt = String(req.query.format || 'json').toLowerCase();
  const session = id
    ? sessions.find((s) => s.id === id)
    : (currentSession || sessions[0]);

  if (!session) {
    return res.status(404).json({ error: 'Aucune session de test trouvée.' });
  }

  if (fmt === 'txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="k6-resume-${session.id}.txt"`);
    return res.send(buildTxtReport(session));
  }

  if (fmt === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="k6-rapport-${session.id}.html"`);
    return res.send(buildHtmlReport(session));
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="k6-rapport-${session.id}.json"`);
  res.send(JSON.stringify(buildJsonReport(session), null, 2));
});

// --- RAPPORT HTML : page autoportée (graphiques SVG + toutes les métriques) ---
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

// Un graphique SVG statique (grille + axes + une polyligne par série).
// Renvoie { svg, data } : data alimente le survol (crosshair + infobulle).
function svgChart(times, seriesList) {
  const W = 880, H = 170, pL = 50, pR = 14, pT = 12, pB = 24;
  const iw = W - pL - pR, ih = H - pT - pB;
  const n = times.length;

  let max = 0;
  for (const s of seriesList) for (const v of s.values) if (v != null && isFinite(v) && v > max) max = v;
  const top = niceMaxH(max);

  const X = (i) => pL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const Y = (v) => pT + ih - (v / top) * ih;
  const axisLbl = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : v % 1 ? v.toFixed(1) : String(v));
  const tLbl = (iso) => new Date(iso).toLocaleTimeString('fr-FR');

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
  const paths = seriesList.map((s) => {
    let d = '';
    s.values.forEach((v, i) => {
      if (v == null || !isFinite(v)) return;
      d += (d ? ' L' : 'M') + `${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
    });
    return `<path d="${d}" stroke="${s.color}" fill="none" stroke-width="1.8"/>`;
  }).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%">${g}${paths}<line class="crs" x1="0" y1="${pT}" x2="0" y2="${pT + ih}" style="display:none"/></svg>`;
  return { svg, data: { times, series: seriesList.map((s) => ({ name: s.name, fmt: s.fmt, values: s.values })) } };
}

function buildHtmlReport(s) {
  const rep = buildJsonReport(s);
  const rows = rep.series.rows;
  const times = rows.map((r) => r.t);
  const M = (k) => rows.map((r) => (r.metrics[k] ? r.metrics[k].avg : null));
  const Mp = (k) => rows.map((r) => (r.metrics[k] ? r.metrics[k].p95 : null));

  const charts = [
    { title: 'VUS', list: [{ name: 'VUS actifs', color: '#46e5b1', fmt: 'int', values: rows.map((r) => r.vus) }] },
    { title: 'HTTP req/s', list: [
      { name: 'req/s', color: '#46e5b1', fmt: 'int', values: rows.map((r) => r.reqRate) },
      { name: 'failed/s', color: '#ff5c5c', fmt: 'int', values: rows.map((r) => r.failedRate) }] },
    { title: 'Données (B/s)', list: [
      { name: 'reçues', color: '#5eb1ff', fmt: 'bps', values: rows.map((r) => r.dataRecvRate) },
      { name: 'envoyées', color: '#ffb224', fmt: 'bps', values: rows.map((r) => r.dataSentRate) }] },
    { title: 'Checks passés (%)', list: [
      { name: 'checks %', color: '#46e5b1', fmt: 'pct', values: rows.map((r) => r.checksPct) }] },
    { title: 'Échecs (%)', list: [
      { name: 'failed %', color: '#ff5c5c', fmt: 'pct', values: rows.map((r) => r.failedPct) }] },
    { title: 'Itérations/s', list: [
      { name: 'itér./s', color: '#46e5b1', fmt: 'int', values: rows.map((r) => r.iterRate) }] }
  ];
  const metricNames = Object.keys(rep.metrics).sort();
  for (const name of metricNames) {
    charts.push({ title: name, list: [
      { name: 'avg', color: '#46e5b1', fmt: 'num', values: M(name) },
      { name: 'p95', color: '#ffb224', fmt: 'num', values: Mp(name) }] });
  }
  const built = charts.map((c) => svgChart(times, c.list));
  const data = built.map((b) => b.data);

  const t = rep.totals;
  const workersRows = rep.workers.map((w) => `
    <tr><td>${htmlEsc(w.id)}</td><td>${w.error ? htmlEsc(w.error) : (w.exitCode == null ? '—' : `code ${w.exitCode}`)}</td><td>${w.finishedAt ? htmlEsc(new Date(w.finishedAt).toLocaleString('fr-FR')) : '—'}</td></tr>`).join('');
  const metricRows = metricNames.map((name) => {
    const m = rep.metrics[name];
    return `<tr><td class="mn">${htmlEsc(name)}</td><td>${fmtH(m.count, 0)}</td><td>${fmtH(m.rate, 1)}</td><td>${fmtH(m.min)}</td><td>${fmtH(m.avg)}</td><td>${fmtH(m.p70)}</td><td>${fmtH(m.p80)}</td><td>${fmtH(m.p90)}</td><td>${fmtH(m.p95)}</td><td>${fmtH(m.p99)}</td><td>${fmtH(m.max)}</td></tr>`;
  }).join('');
  const logsHtml = Object.entries(rep.logs).map(([id, lines]) => `
    <details open><summary>${htmlEsc(id)} — ${lines.length} ligne(s)</summary><pre>${htmlEsc(lines.join('\n'))}</pre></details>`).join('');

  const genAt = new Date().toLocaleString('fr-FR');
  const page = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rapport k6 — ${htmlEsc(rep.session.id)}</title>
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
  svg { display: block; }
  .gl { stroke: rgba(160,180,210,.08); }
  .ax { fill: rgba(125,140,160,.85); font: 10px "IBM Plex Mono", ui-monospace, monospace; }
  .crs { stroke: rgba(220,235,255,.4); stroke-dasharray: 3 3; }
  #tip { position: fixed; display: none; pointer-events: none; background: #101823; border: 1px solid rgba(70,229,177,.4); border-radius: 6px; padding: 6px 9px; font: 12px/1.6 "IBM Plex Mono", ui-monospace, monospace; color: #d7e3ee; z-index: 10; white-space: nowrap; }
  #tip .tt { color: #46e5b1; }
  summary { cursor: pointer; color: #9fb0c4; }
  pre { background: #0d141d; border: 1px solid rgba(140,165,195,.15); border-radius: 6px; padding: 10px; font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; overflow-x: auto; }
  .foot { margin-top: 36px; color: #5c6b80; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Rapport k6 distribué</h1>
  <p class="sub">${htmlEsc(rep.session.id)} — ${htmlEsc(rep.session.overall)} · ${htmlEsc(String(rep.session.totalVus))} VUs · durée ${htmlEsc(String(rep.session.duration))}</p>

  <h2>Synthèse</h2>
  <div class="grid">
    <div class="cell"><span>VUS max</span><b>${fmtH(t.vusMax, 0)}</b></div>
    <div class="cell"><span>Requêtes HTTP</span><b>${fmtH(t.httpReqs, 0)}</b></div>
    <div class="cell"><span>Taux d'échecs</span><b>${fmtH(t.failedPct)} %</b></div>
    <div class="cell"><span>Données reçues</span><b>${fmtBytesH(t.dataReceived)}</b></div>
    <div class="cell"><span>Données envoyées</span><b>${fmtBytesH(t.dataSent)}</b></div>
    <div class="cell"><span>Itérations</span><b>${fmtH(t.iterations, 0)}</b></div>
    <div class="cell"><span>Checks</span><b>${fmtH(t.checksPct)} %</b></div>
  </div>

  <h2>Workers</h2>
  <table>
    <thead><tr><th>Worker</th><th>Résultat</th><th>Fin</th></tr></thead>
    <tbody>${workersRows}</tbody>
  </table>

  <h2>Graphiques</h2>
  ${built.map((b, i) => `<figure class="rpt-chart"><figcaption>${htmlEsc(charts[i].title)}</figcaption>${b.svg}</figure>`).join('')}

  <h2>Toutes les métriques</h2>
  <table>
    <thead><tr><th>Métrique</th><th>count</th><th>rate</th><th>min</th><th>avg</th><th>p70</th><th>p80</th><th>p90</th><th>p95</th><th>p99</th><th>max</th></tr></thead>
    <tbody>${metricRows}</tbody>
  </table>

  <h2>Logs par worker</h2>
  ${logsHtml || '<p class="sub">Aucun log.</p>'}

  <p class="foot">Généré le ${genAt} par l'orchestrateur k6 distribué — survolez les graphiques pour lire les valeurs à l'instant t.</p>
</div>
<div id="tip"></div>
<script>
(function () {
  var DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
  var W = 880, pL = 50, pR = 14;
  var F = {
    int: function (v) { return v == null ? '—' : Math.round(v).toLocaleString('fr-FR'); },
    num: function (v) { return v == null ? '—' : Number(v).toFixed(2); },
    pct: function (v) { return v == null ? '—' : Number(v).toFixed(2) + ' %'; },
    bps: function (v) { return v == null ? '—' : (v < 1000 ? Math.round(v) + ' B/s' : v < 1e6 ? (v / 1e3).toFixed(1) + ' kB/s' : (v / 1e6).toFixed(2) + ' MB/s'); }
  };
  var tip = document.getElementById('tip');
  document.querySelectorAll('figure.rpt-chart').forEach(function (fig, k) {
    var d = DATA[k];
    if (!d) return;
    var svg = fig.querySelector('svg');
    var crs = svg.querySelector('.crs');
    var n = d.times.length;
    svg.addEventListener('mousemove', function (ev) {
      if (!n) return;
      var r = svg.getBoundingClientRect();
      var scale = r.width / W;
      var mx = (ev.clientX - r.left) / scale;
      var i = n === 1 ? 0 : Math.round(((mx - pL) / (W - pL - pR)) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      var x = pL + (n === 1 ? (W - pL - pR) / 2 : (i / (n - 1)) * (W - pL - pR));
      crs.setAttribute('x1', x);
      crs.setAttribute('x2', x);
      crs.style.display = '';
      var html = '<span class="tt">' + new Date(d.times[i]).toLocaleString('fr-FR') + '</span>';
      d.series.forEach(function (s) {
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
  });
})();
</script>
</body>
</html>`;
  return page;
}

// Sortie JSON BRUTE de k6 d'un worker (contenu du `--out json=`, une ligne JSON par point de données)
app.get('/api/raw-metrics', (req, res) => {
  const id = req.query.session;
  const workerId = req.query.worker;
  const session = id
    ? sessions.find((s) => s.id === id)
    : (currentSession || sessions[0]);

  if (!session) {
    return res.status(404).json({ error: 'Aucune session de test trouvée.' });
  }

  const lines = session.rawMetrics.get(workerId);
  if (!workerId || !lines || lines.length === 0) {
    return res.status(404).json({ error: 'Aucun point de données brut pour ce worker (pas de --out json= reçu).' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="k6-out-${session.id}-${workerId}.jsonl"`);
  res.send(lines.join('\n') + '\n');
});
// --- CONSOLE WEB : events UI + GESTION DU CANAL SOCKET ---
function handleDashboardSocket(socket) {
  socket.join('dashboard');

  // État initial : workers, session en cours (si existante) et historique
  socket.emit('ui:state', {
    workers: workersList(),
    session: currentSession ? sessionState(currentSession) : null,
    latestSession: sessions[0] ? sessionState(sessions[0]) : null,
    sessions: sessionsSummary()
  });

  // Rejeu pour une UI qui se connecte en plein test
  if (currentSession && currentSession.status === 'RUNNING') {
    const workers = {};
    for (const [id, arr] of currentSession.workerLogs) workers[id] = arr.slice(-500);
    socket.emit('ui:logs_replay', { session: currentSession.id, workers });
    socket.emit('ui:metrics_replay', { session: currentSession.id, rows: currentSession.history.slice(-300) });
  }

  // Rejeu à la demande : l'utilisateur a sélectionné une session dans le bandeau « Rapport »
  // → on rejoue l'historique complet (snapshots par seconde + logs par worker) de cette session.
  socket.on('ui:show_session', ({ session }) => {
    const s = sessions.find((x) => x.id === session);
    if (!s) return;
    const workers = {};
    for (const [id, arr] of s.workerLogs) workers[id] = arr;
    socket.emit('ui:logs_replay', { session: s.id, workers });
    socket.emit('ui:metrics_replay', { session: s.id, rows: s.history });
    socket.emit('ui:session_state', sessionState(s));
  });
}

io.on('connection', (socket) => {
  const workerId = socket.handshake.auth && socket.handshake.auth.workerId;

  // --- Cas 1 : une console web s'est connectée (pas de workerId dans l'auth) ---
  if (!workerId) {
    console.log(`[Orchestrateur] Console web connectée (Socket: ${socket.id})`);
    handleDashboardSocket(socket);
    return;
  }

  // --- Cas 2 : un worker (agent) s'enregistre ---
  console.log(`[Orchestrateur] Worker connecté : ${workerId} (Socket: ${socket.id})`);

  workersRegistry.set(workerId, {
    id: workerId,
    socketId: socket.id,
    status: 'AVAILABLE'
  });
  broadcastWorkers();

  socket.on('worker:ready', (data) => {
    const worker = workersRegistry.get(workerId);
    if (worker) {
      worker.status = data.status || 'AVAILABLE';
      console.log(`[Orchestrateur] Worker ${workerId} synchronisé. Statut actuel : ${worker.status}`);
      broadcastWorkers();
    }
  });

  socket.on('worker:status_changed', (data) => {
    const worker = workersRegistry.get(workerId);
    if (worker) {
      worker.status = data.status;
      console.log(`[Orchestrateur] Changement de statut pour ${workerId} -> ${data.status}`);
      broadcastWorkers();
    }
  });

  // Logs de console k6 (stdout / stderr) — stockés par worker, diffusés vers la console
  socket.on('worker:log', (data) => {
    const type = data.type === 'stderr' ? 'stderr' : 'stdout';
    const text = data.output || '';
    console.log(`[LOG][${workerId}][${type.toUpperCase()}] ${text.trim()}`);
    ingestLog(workerId, type, text);
  });

  // Points de données k6 (format JSON de `--out json=`) — agrégés pour les graphiques
  socket.on('worker:metrics', (data) => {
    if (data && Array.isArray(data.data)) ingestMetrics(workerId, data.data);
  });

  socket.on('worker:test_finished', (data) => {
    console.log(`[Orchestrateur] Le worker ${workerId} a complété son test (Code de sortie k6 : ${data.exitCode})`);
    markWorkerFinished(workerId, { exitCode: data.exitCode });
  });

  socket.on('worker:error', (data) => {
    console.error(`[Orchestrateur][ERREUR] Signalement de ${workerId} :`, data.message);
  });

  socket.on('disconnect', () => {
    console.log(`[Orchestrateur] Worker déconnecté : ${workerId}`);
    workersRegistry.delete(workerId);
    broadcastWorkers();
    // Si le worker portait une part de la session en cours, on clôt son entrée
    markWorkerFinished(workerId, { error: 'Worker déconnecté' });
  });
});

// Lancement du serveur d'orchestration
httpServer.listen(PORT, () => {
  console.log(`\x1b[32m%s\x1b[0m`, `[Orchestrateur] Serveur démarré sur le port ${PORT}`);
  console.log(`[Orchestrateur] Console web disponible sur http://localhost:${PORT}`);
  console.log('[Orchestrateur] En attente de connexions de workers sur le protocole socket.io...');
});



