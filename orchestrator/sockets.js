// Socket.io channel: connections of the workers (agents) and of the web console.
//
// Two socket profiles, distinguished by the `auth.workerId` of the handshake:
//   - no workerId -> a web console (initial state + replays);
//   - workerId    -> a worker (ready, logs, metrics, end of test).
import {
  workersRegistry,
  sessions,
  getCurrentSession,
  sessionState,
  sessionsSummary,
  workersList,
  broadcastWorkers
} from './state.js';
import { ingestLog, markWorkerFinished } from './workers.js';
import { ingestMetrics } from './metrics.js';

export function registerSockets(io) {
  io.on('connection', (socket) => {
    const workerId = socket.handshake.auth && socket.handshake.auth.workerId;

    // --- Case 1: a web console has connected (no workerId in the auth) ---
    if (!workerId) {
      console.log(`[Orchestrator] Web console connected (Socket: ${socket.id})`);
      handleDashboardSocket(socket);
      return;
    }

    // --- Case 2: a worker (agent) registers ---
    handleWorkerSocket(io, socket, workerId);
  });
}

// --- WEB CONSOLE: initial state, live replay, on-demand session replay ---
function handleDashboardSocket(socket) {
  socket.join('dashboard');

  // Initial state: workers, current session (if any) and history
  socket.emit('ui:state', {
    workers: workersList(),
    session: getCurrentSession() ? sessionState(getCurrentSession()) : null,
    latestSession: sessions[0] ? sessionState(sessions[0]) : null,
    sessions: sessionsSummary()
  });

  // Replay for a UI that connects mid-test
  const current = getCurrentSession();
  if (current && current.status === 'RUNNING') {
    const workers = {};
    for (const [id, arr] of current.workerLogs) workers[id] = arr.slice(-500);
    socket.emit('ui:logs_replay', { session: current.id, workers });
    socket.emit('ui:metrics_replay', { session: current.id, rows: current.history.slice(-300) });
  }

  // On-demand replay: the user selected a session in the "Report" strip
  // -> we replay the full history (per-second snapshots + per-worker logs) of that session.
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

// --- WORKER (AGENT): registration + test events ---
function handleWorkerSocket(io, socket, workerId) {
  console.log(`[Orchestrator] Worker connected: ${workerId} (Socket: ${socket.id})`);

  workersRegistry.set(workerId, {
    id: workerId,
    socketId: socket.id,
    status: 'AVAILABLE'
  });
  broadcastWorkers(io);

  socket.on('worker:ready', (data) => {
    const worker = workersRegistry.get(workerId);
    if (worker) {
      worker.status = data.status || 'AVAILABLE';
      console.log(`[Orchestrator] Worker ${workerId} synchronized. Current status: ${worker.status}`);
      broadcastWorkers(io);
    }
  });

  socket.on('worker:status_changed', (data) => {
    const worker = workersRegistry.get(workerId);
    if (worker) {
      worker.status = data.status;
      console.log(`[Orchestrator] Status change for ${workerId} -> ${data.status}`);
      broadcastWorkers(io);
    }
  });

  // k6 console logs (stdout / stderr) — stored per worker, broadcast to the console
  socket.on('worker:log', (data) => {
    const type = data.type === 'stderr' ? 'stderr' : 'stdout';
    const text = data.output || '';
    console.log(`[LOG][${workerId}][${type.toUpperCase()}] ${text.trim()}`);
    ingestLog(io, workerId, type, text);
  });

  // k6 data points (JSON format of `--out json=`) — aggregated for the charts
  socket.on('worker:metrics', (data) => {
    if (data && Array.isArray(data.data)) ingestMetrics(workerId, data.data);
  });

  socket.on('worker:test_finished', (data) => {
    console.log(`[Orchestrator] Worker ${workerId} completed its test (k6 exit code: ${data.exitCode})`);
    markWorkerFinished(io, workerId, { exitCode: data.exitCode });
  });

  socket.on('worker:error', (data) => {
    console.error(`[Orchestrator][ERROR] Report from ${workerId}:`, data.message);
  });

  socket.on('disconnect', () => {
    console.log(`[Orchestrator] Worker disconnected: ${workerId}`);
    workersRegistry.delete(workerId);
    broadcastWorkers(io);
    // If the worker held a share of the current session, close its entry
    markWorkerFinished(io, workerId, { error: 'Worker disconnected' });
  });
}