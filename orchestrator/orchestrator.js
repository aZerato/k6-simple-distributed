import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// --- LIMITES MÉMOIRE / CONSOLE ---
const MAX_SESSIONS = 10;          // sessions conservées (plus récentes d'abord)
const MAX_STORED_LINES = 20000;   // lignes de logs conservées par session
const MAX_REPLAY_LINES = 2000;    // lignes rejouées à une UI qui se connecte en retard

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
// Structure d'un worker : { id: string, socketId: string, status: 'AVAILABLE' | 'BUSY' }
const workersRegistry = new Map();

// Sessions de test : une seule peut être en cours à la fois
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
    linesCount: session.lines.length,
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
    linesCount: s.lines.length
  }));
}

// --- SESSIONS : CRÉATION & STOCKAGE DES LOGS ---
function createSession({ totalVus, duration }) {
  const session = {
    id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'RUNNING',
    createdAt: new Date(),
    finishedAt: null,
    totalVus,
    duration,
    workers: new Map(),   // workerId -> { exitCode, finishedAt, error }
    pending: {},           // workerId -> fragment de ligne non terminé
    lines: [],             // { t, seq, workerId, type, text }
    seq: 0
  };
  sessions.unshift(session);
  if (sessions.length > MAX_SESSIONS) sessions.pop();
  currentSession = session;
  return session;
}

function pushLine(session, workerId, type, text) {
  if (text === '') return;
  const t = new Date();
  const entry = { t, seq: ++session.seq, workerId, type, text };
  session.lines.push(entry);
  if (session.lines.length > MAX_STORED_LINES) session.lines.shift();
  io.to('dashboard').emit('ui:log', {
    session: session.id,
    workerId,
    type,
    text,
    t: t.toISOString(),
    seq: entry.seq
  });
}

// Incrémente le tampon de ligne du worker puis pousse les lignes complètes
function ingestLog(workerId, type, output) {
  const session = currentSession;
  if (!session || session.status !== 'RUNNING') return;
  let buf = (session.pending[workerId] || '') + output;
  const parts = buf.split(/[\r\n]+/);
  // Le dernier fragment est potentiellement incomplet : on le conserve
  session.pending[workerId] = parts.pop();
  for (const text of parts) pushLine(session, workerId, type, text);
}

function markWorkerFinished(workerId, { exitCode = null, error = null } = {}) {
  const session = sessions.find((s) => s.workers.has(workerId));
  if (!session) return;
  const entry = session.workers.get(workerId);
  if (entry.finishedAt) return; // déjà clôturé (évite les doublons)

  //Flush du dernier fragment de ligne non terminé de ce worker
  const rest = session.pending[workerId];
  session.pending[workerId] = '';
  if (rest) pushLine(session, workerId, 'stdout', rest);

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

// --- RAPPORT TEXTE (téléchargeable) ---
function buildReport(session) {
  const W = 76;
  const bar = (ch = '-') => ch.repeat(W);
  const out = [];

  out.push(bar('='));
  out.push('  RAPPORT DE TEST k6 DISTRIBUÉ');
  out.push(bar('='));
  out.push('');
  out.push('  SESSION');
  out.push(`  Identifiant    : ${session.id}`);
  out.push(`  Statut global  : ${session.status === 'RUNNING' ? 'EN COURS' : `TERMINÉ — ${sessionOverallStatus(session)}`}`);
  out.push(`  Début          : ${dateFr(session.createdAt)}`);
  out.push(`  Fin            : ${session.finishedAt ? dateFr(session.finishedAt) : '—'}`);
  out.push(`  VUS totales    : ${session.totalVus}`);
  out.push(`  Durée demandée : ${session.duration}`);
  out.push('');
  out.push('  WORKERS');
  if (session.workers.size === 0) {
    out.push('  (aucun worker ciblé)');
  } else {
    for (const [id, w] of session.workers) {
      const res = w.error ? `erreur : ${w.error}` : `code de sortie ${w.exitCode}`;
      const fin = w.finishedAt ? ` — ${stamp(w.finishedAt)}` : '';
      out.push(`  - ${id.padEnd(28)} : ${res}${fin}`);
    }
  }
  out.push('');
  out.push(bar());
  out.push(`  FLUX DE LOGS CONCATÉNÉ (${session.lines.length} ligne(s))`);
  out.push(bar());
  for (const l of session.lines) {
    out.push(`[${stamp(l.t)}] [${l.workerId}] [${l.type.toUpperCase()}] ${l.text}`);
  }
  out.push(bar());
  out.push('  FIN DU RAPPORT');
  out.push(bar('='));

  return out.join('\n');
}

// --- ENDPOINT HTTP : LANCER UN TEST DISTRIBUÉ ---
// Reçoit le script global, les VUS totales et la durée, puis découpe le travail
app.post('/api/test/start', (req, res) => {
  const { scriptContent, totalVus, duration, envVariables } = req.body;

  if (!scriptContent || !totalVus || !duration) {
    return res.status(400).json({ error: 'Paramètres manquants (scriptContent, totalVus, duration).' });
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
      scriptContent,
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

// --- ENDPOINT HTTP : ARRÊTER TOUS LES TESTS ---
app.post('/api/test/stop', (req, res) => {
  console.log('[Orchestrateur] Demande d\'arrêt d\'urgence généralisée envoyée à tous les workers.');
  io.emit('orchestrator:stop_test');
  res.json({ message: 'Ordre d\'arrêt envoyé à l\'ensemble du réseau.' });
});

// --- ENDPOINT HTTP : LISTER LES WORKERS ---
app.get('/api/workers', (req, res) => {
  res.json(Array.from(workersRegistry.values()));
});

// --- ENDPOINTS : SESSIONS & RAPPORT ---
app.get('/api/test/sessions', (req, res) => {
  res.json(sessionsSummary());
});

// Renvoie le flux concaténée (horodaté + étiqueté par worker) sous forme de fichier
app.get('/api/test/report', (req, res) => {
  const id = req.query.session;
  const session = id
    ? sessions.find((s) => s.id === id)
    : (currentSession || sessions[0]);

  if (!session) {
    return res.status(404).json({ error: 'Aucune session de test trouvée.' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="k6-rapport-${session.id}.txt"`);
  res.send(buildReport(session));
});

// --- CONSOLE WEB (fichiers statiques + events UI) ---
function handleDashboardSocket(socket) {
  socket.join('dashboard');

  // État initial : workers, session en cours (si existante) et historique
  socket.emit('ui:state', {
    workers: workersList(),
    session: currentSession ? sessionState(currentSession) : null,
    latestSession: sessions[0] ? sessionState(sessions[0]) : null,
    sessions: sessionsSummary()
  });

  // Rejeu des lignes déjà produites pour une UI qui se connecte en retard
  if (currentSession && currentSession.status === 'RUNNING') {
    socket.emit('ui:logs_bulk', {
      session: currentSession.id,
      lines: currentSession.lines.slice(-MAX_REPLAY_LINES)
    });
  }
}

// --- GESTION DU CANAL SOCKET TEMPS RÉEL ---
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

  // Enregistrement par défaut du worker à l'état Disponible
  workersRegistry.set(workerId, {
    id: workerId,
    socketId: socket.id,
    status: 'AVAILABLE'
  });
  broadcastWorkers();

  // Événement : Le worker confirme qu'il est prêt et partage son statut initial
  socket.on('worker:ready', (data) => {
    const worker = workersRegistry.get(workerId);
    if (worker) {
      worker.status = data.status || 'AVAILABLE';
      console.log(`[Orchestrateur] Worker ${workerId} synchronisé. Statut actuel : ${worker.status}`);
      broadcastWorkers();
    }
  });

  // Événement : Changement de statut (ex: AVAILABLE -> BUSY au début du k6)
  socket.on('worker:status_changed', (data) => {
    const worker = workersRegistry.get(workerId);
    if (worker) {
      worker.status = data.status;
      console.log(`[Orchestrateur] Changement de statut pour ${workerId} -> ${data.status}`);
      broadcastWorkers();
    }
  });

  // Événement : Réception des logs de la console k6 en temps réel
  socket.on('worker:log', (data) => {
    const type = data.type === 'stderr' ? 'stderr' : 'stdout';
    const text = data.output || '';
    console.log(`[LOG][${workerId}][${type.toUpperCase()}] ${text.trim()}`);
    ingestLog(workerId, type, text);
  });

  // Événement : k6 a fini son travail sur ce nœud
  socket.on('worker:test_finished', (data) => {
    console.log(`[Orchestrateur] Le worker ${workerId} a complété son test (Code de sortie k6 : ${data.exitCode})`);
    markWorkerFinished(workerId, { exitCode: data.exitCode });
  });

  // Événement : Le worker a rencontré une erreur logicielle interne
  socket.on('worker:error', (data) => {
    console.error(`[Orchestrateur][ERREUR] Signalement de ${workerId} :`, data.message);
  });

  // Événement : Perte de connexion ou arrêt de l'agent
  socket.on('disconnect', () => {
    console.log(`[Orchestrateur] Worker déconnecté : ${workerId}`);
    workersRegistry.delete(workerId);
    broadcastWorkers();
    // Si le worker portait une part de la session en cours, on clôt son entrée
    // pour que la session puisse se terminer proprement
    markWorkerFinished(workerId, { error: 'Worker déconnecté' });
  });
});

// Lancement du serveur d'orchestration
httpServer.listen(PORT, () => {
  console.log(`\x1b[32m%s\x1b[0m`, `[Orchestrateur] Serveur démarré sur le port ${PORT}`);
  console.log(`[Orchestrateur] Console web disponible sur http://localhost:${PORT}`);
  console.log('[Orchestrateur] En attente de connexions de workers sur le protocole socket.io...');
});
