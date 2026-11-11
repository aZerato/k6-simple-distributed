// Événements émis par les workers : logs de console k6 (stdout/stderr) et
// fin de test.
//
// Les logs sont stockés par worker (jamais concaténés), plafonnés en
// mémoire, et diffusés en direct vers la console web (ui:log).
import { MAX_LOG_LINES_PER_WORKER } from './constants.js';
import {
  sessions,
  getCurrentSession,
  resyncCurrentSession,
  broadcastSession,
  broadcastWorkers
} from './state.js';

// Ajoute une ligne de log du worker et la diffuse vers la console
export function pushWorkerLine(io, workerId, type, text) {
  const s = getCurrentSession();
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
export function ingestLog(io, workerId, type, output) {
  const s = getCurrentSession();
  if (!s || s.status !== 'RUNNING') return;
  let buf = (s.pending[workerId] || '') + output;
  const parts = buf.split(/[\r\n]+/);
  // Le dernier fragment est potentiellement incomplet : on le conserve
  s.pending[workerId] = parts.pop();
  for (const text of parts) pushWorkerLine(io, workerId, type, text);
}

// Clôt l'entrée du worker dans sa session (fin de test, erreur, déconnexion)
export function markWorkerFinished(io, workerId, { exitCode = null, error = null } = {}) {
  const session = sessions.find((s) => s.workers.has(workerId));
  if (!session) return;
  const entry = session.workers.get(workerId);
  if (entry.finishedAt) return; // déjà clôturé (évite les doublons)

  // Flush du dernier fragment de ligne non terminé de ce worker
  const rest = session.pending[workerId];
  session.pending[workerId] = '';
  if (rest) pushWorkerLine(io, workerId, 'stdout', rest);

  entry.exitCode = exitCode;
  entry.error = error || null;
  entry.finishedAt = new Date();

  if (session.status === 'RUNNING' && [...session.workers.values()].every((e) => e.finishedAt)) {
    session.status = 'FINISHED';
    session.finishedAt = new Date();
  }
  if (getCurrentSession() === session && session.status === 'FINISHED') {
    resyncCurrentSession();
  }

  broadcastSession(io, session);
  broadcastWorkers(io);
  console.log(`[Orchestrateur] Worker ${workerId} : ${entry.error ? `erreur (${entry.error})` : `code de sortie ${entry.exitCode}`}`);
}
