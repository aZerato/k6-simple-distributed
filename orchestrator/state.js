// Registre en mémoire : workers connus + sessions de test.
//
// Source de vérité de la « session courante » (le test RUNNING) et des
// diffusions vers la console web (ui:workers / ui:session_state).
// Le module socket.io est passé en paramètre pour garder ce module
// indépendant du transport.
import { MAX_SESSIONS } from './constants.js';

// Registre pour suivre l'état de nos workers
export const workersRegistry = new Map(); // workerId -> { id, socketId, status }
export const sessions = [];               // sessions (plus récentes d'abord, plafonné à MAX_SESSIONS)
let currentSession = null;

export function getCurrentSession() { return currentSession; }

export function setCurrentSession(session) { currentSession = session; }

// Après la fin d'un test, on repique la session encore en cours (ou aucune)
export function resyncCurrentSession() {
  currentSession = sessions.find((s) => s.status === 'RUNNING') || null;
}

export function createSession({ totalVus, duration }) {
  const session = {
    id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'RUNNING',
    createdAt: new Date(),
    finishedAt: null,
    totalVus,
    duration,
    workers: new Map(),        // workerId -> { exitCode, finishedAt, error }
    pending: {},                // workerId -> fragment de log non terminé
    workerLogs: new Map(),     // workerId -> [ { t, type, text, seq } ]
    metrics: new Map(),        // metric name -> MetricAgg (fusion de tous les workers)
    metricsByWorker: new Map(),// workerId -> Map(metric name -> MetricAgg)
    vusPeak: 0,                // plus haut niveau de VUS fusionné (somme des workers)
    rawMetrics: new Map(),     // workerId -> [ ligne JSON brute (format `--out json=` k6) ]
    rawTruncated: false,       // le buffer brut a-t-il été tronqué (plafond mémoire) ?
    history: [],                // snapshots par seconde
    seq: 0
  };
  sessions.unshift(session);
  if (sessions.length > MAX_SESSIONS) sessions.pop();
  currentSession = session;
  return session;
}

export function sessionOverallStatus(session) {
  if (session.status === 'RUNNING') return 'EN COURS';
  const entries = [...session.workers.values()];
  if (entries.some((e) => e.error)) return 'INTERROMPU';
  if (entries.some((e) => e.exitCode !== 0)) return 'ÉCHEC';
  return 'SUCCÈS';
}

export function vusOf(s) { return s.metrics.get('vus'); }

export function workersList() {
  return [...workersRegistry.values()].map((w) => ({ id: w.id, status: w.status }));
}

// État d'une session tel qu'envoyé à la console web (ui:session_state)
export function sessionState(session) {
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

// Résumé compact des sessions pour le bandeau « Rapport » de la console
export function sessionsSummary() {
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
    vusMax: s.vusPeak || (vusOf(s) ? (s.metrics.get('vus') ? s.metrics.get('vus').max : 0) : 0)
  }));
}

// --- DIFFUSIONS VERS LA CONSOLE WEB ---
export function broadcastWorkers(io) {
  io.to('dashboard').emit('ui:workers', workersList());
}

export function broadcastSession(io, session) {
  io.to('dashboard').emit('ui:session_state', sessionState(session));
}
