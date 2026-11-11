// In-memory registry: known workers + test sessions.
//
// Source of truth for the "current session" (the RUNNING test) and for the
// broadcasts toward the web console (ui:workers / ui:session_state).
// The socket.io module is passed as a parameter to keep this module
// independent from the transport.
import { MAX_SESSIONS } from './constants.js';

// Registry to track the state of our workers
export const workersRegistry = new Map(); // workerId -> { id, socketId, status }
export const sessions = [];               // sessions (newest first, capped at MAX_SESSIONS)
let currentSession = null;

export function getCurrentSession() { return currentSession; }

export function setCurrentSession(session) { currentSession = session; }

// After a test ends, re-point to the session still running (or none)
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
    pending: {},                // workerId -> unfinished log fragment
    workerLogs: new Map(),     // workerId -> [ { t, type, text, seq } ]
    metrics: new Map(),        // metric name -> MetricAgg (fusion of every worker)
    metricsByWorker: new Map(),// workerId -> Map(metric name -> MetricAgg)
    vusPeak: 0,                // highest fused VUS level (sum of the workers)
    rawMetrics: new Map(),     // workerId -> [ raw JSON line (k6 `--out json=` format) ]
    rawTruncated: false,       // has the raw buffer been truncated (memory cap)?
    history: [],                // per-second snapshots
    seq: 0
  };
  sessions.unshift(session);
  if (sessions.length > MAX_SESSIONS) sessions.pop();
  currentSession = session;
  return session;
}

export function sessionOverallStatus(session) {
  if (session.status === 'RUNNING') return 'IN PROGRESS';
  const entries = [...session.workers.values()];
  if (entries.some((e) => e.error)) return 'INTERRUPTED';
  if (entries.some((e) => e.exitCode !== 0)) return 'FAILURE';
  return 'SUCCESS';
}

export function vusOf(s) { return s.metrics.get('vus'); }

export function workersList() {
  return [...workersRegistry.values()].map((w) => ({ id: w.id, status: w.status }));
}

// State of a session as sent to the web console (ui:session_state)
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

// Compact summary of the sessions for the console "Report" strip
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

// --- BROADCASTS TO THE WEB CONSOLE ---
export function broadcastWorkers(io) {
  io.to('dashboard').emit('ui:workers', workersList());
}

export function broadcastSession(io, session) {
  io.to('dashboard').emit('ui:session_state', sessionState(session));
}