// Canal Socket.io : connexions des workers (agents) et de la console web.
//
// Deux profils de socket, distingués par l'`auth.workerId` du handshake :
//   - pas de workerId → une console web (état initial + rejeux) ;
//   - workerId       → un worker (ready, logs, métriques, fin de test).
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

    // --- Cas 1 : une console web s'est connectée (pas de workerId dans l'auth) ---
    if (!workerId) {
      console.log(`[Orchestrateur] Console web connectée (Socket: ${socket.id})`);
      handleDashboardSocket(socket);
      return;
    }

    // --- Cas 2 : un worker (agent) s'enregistre ---
    handleWorkerSocket(io, socket, workerId);
  });
}

// --- CONSOLE WEB : état initial, rejeu live, rejeu d'une session à la demande ---
function handleDashboardSocket(socket) {
  socket.join('dashboard');

  // État initial : workers, session en cours (si existante) et historique
  socket.emit('ui:state', {
    workers: workersList(),
    session: getCurrentSession() ? sessionState(getCurrentSession()) : null,
    latestSession: sessions[0] ? sessionState(sessions[0]) : null,
    sessions: sessionsSummary()
  });

  // Rejeu pour une UI qui se connecte en plein test
  const current = getCurrentSession();
  if (current && current.status === 'RUNNING') {
    const workers = {};
    for (const [id, arr] of current.workerLogs) workers[id] = arr.slice(-500);
    socket.emit('ui:logs_replay', { session: current.id, workers });
    socket.emit('ui:metrics_replay', { session: current.id, rows: current.history.slice(-300) });
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

// --- WORKER (AGENT) : enregistrement + événements du test ---
function handleWorkerSocket(io, socket, workerId) {
  console.log(`[Orchestrateur] Worker connecté : ${workerId} (Socket: ${socket.id})`);

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
      console.log(`[Orchestrateur] Worker ${workerId} synchronisé. Statut actuel : ${worker.status}`);
      broadcastWorkers(io);
    }
  });

  socket.on('worker:status_changed', (data) => {
    const worker = workersRegistry.get(workerId);
    if (worker) {
      worker.status = data.status;
      console.log(`[Orchestrateur] Changement de statut pour ${workerId} -> ${data.status}`);
      broadcastWorkers(io);
    }
  });

  // Logs de console k6 (stdout / stderr) — stockés par worker, diffusés vers la console
  socket.on('worker:log', (data) => {
    const type = data.type === 'stderr' ? 'stderr' : 'stdout';
    const text = data.output || '';
    console.log(`[LOG][${workerId}][${type.toUpperCase()}] ${text.trim()}`);
    ingestLog(io, workerId, type, text);
  });

  // Points de données k6 (format JSON de `--out json=`) — agrégés pour les graphiques
  socket.on('worker:metrics', (data) => {
    if (data && Array.isArray(data.data)) ingestMetrics(workerId, data.data);
  });

  socket.on('worker:test_finished', (data) => {
    console.log(`[Orchestrateur] Le worker ${workerId} a complété son test (Code de sortie k6 : ${data.exitCode})`);
    markWorkerFinished(io, workerId, { exitCode: data.exitCode });
  });

  socket.on('worker:error', (data) => {
    console.error(`[Orchestrateur][ERREUR] Signalement de ${workerId} :`, data.message);
  });

  socket.on('disconnect', () => {
    console.log(`[Orchestrateur] Worker déconnecté : ${workerId}`);
    workersRegistry.delete(workerId);
    broadcastWorkers(io);
    // Si le worker portait une part de la session en cours, on clôt son entrée
    markWorkerFinished(io, workerId, { error: 'Worker déconnecté' });
  });
}
