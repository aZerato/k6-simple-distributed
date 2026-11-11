// Events emitted by the workers: k6 console logs (stdout/stderr) and
// end of test.
//
// Logs are stored per worker (never concatenated), capped in
// memory, and streamed live to the web console (ui:log).
import { MAX_LOG_LINES_PER_WORKER } from './constants.js';
import {
  sessions,
  getCurrentSession,
  resyncCurrentSession,
  broadcastSession,
  broadcastWorkers
} from './state.js';

// Add a worker log line and broadcast it to the console
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

// Increment the worker's line buffer, then push the complete lines
export function ingestLog(io, workerId, type, output) {
  const s = getCurrentSession();
  if (!s || s.status !== 'RUNNING') return;
  let buf = (s.pending[workerId] || '') + output;
  const parts = buf.split(/[\r\n]+/);
  // The last fragment is potentially incomplete: keep it
  s.pending[workerId] = parts.pop();
  for (const text of parts) pushWorkerLine(io, workerId, type, text);
}

// Close the worker's entry in its session (end of test, error, disconnect)
export function markWorkerFinished(io, workerId, { exitCode = null, error = null } = {}) {
  const session = sessions.find((s) => s.workers.has(workerId));
  if (!session) return;
  const entry = session.workers.get(workerId);
  if (entry.finishedAt) return; // already closed (avoids duplicates)

  // Flush this worker's last unfinished line fragment
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
  console.log(`[Orchestrator] Worker ${workerId}: ${entry.error ? `error (${entry.error})` : `exit code ${entry.exitCode}`}`);
}