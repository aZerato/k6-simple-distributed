import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';

const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
// Configuration de Socket.io avec CORS ouvert pour laisser les workers se connecter
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

// Registre en mémoire pour suivre l'état de nos workers
// Structure d'un worker : { id: string, socketId: string, status: 'AVAILABLE' | 'BUSY' }
const workersRegistry = new Map();

// --- ENDPOINT HTTP : LANCER UN TEST DISTRIBUÉ ---
// Reçoit le script global, les VUs totales et la durée, puis découpe le travail
app.post('/api/test/start', (req, res) => {
  const { scriptContent, totalVus, duration, envVariables } = req.body;

  if (!scriptContent || !totalVus || !duration) {
    return res.status(400).json({ error: "Paramètres manquants (scriptContent, totalVus, duration)." });
  }

  // Filtrer pour obtenir uniquement les workers disponibles
  const availableWorkers = Array.from(workersRegistry.values()).filter(w => w.status === 'AVAILABLE');

  if (availableWorkers.length === 0) {
    return res.status(422).json({ error: "Aucun worker disponible pour le moment." });
  }

  const workersCount = availableWorkers.length;
  // Distribution équitable des Utilisateurs Virtuels (VUs)
  const baseVusPerWorker = Math.floor(totalVus / workersCount);
  const remainderVus = totalVus % workersCount;

  console.log(`[Orchestrateur] Lancement d'un test distribué sur ${workersCount} worker(s).`);

  // Envoi de l'ordre de démarrage personnalisé à chaque worker disponible
  availableWorkers.forEach((worker, index) => {
    // Le premier worker récupère le reste de la division s'il y en a un
    const assignedVus = index === 0 ? baseVusPerWorker + remainderVus : baseVusPerWorker;

    if (assignedVus > 0) {
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
    }
  });

  res.json({ 
    message: "Test distribué initialisé avec succès", 
    workersCibles: workersCount 
  });
});

// --- ENDPOINT HTTP : ARRÊTER TOUS LES TESTS ---
app.post('/api/test/stop', (req, res) => {
  console.log("[Orchestrateur] Demande d'arrêt d'urgence généralisée envoyée à tous les workers.");
  io.emit('orchestrator:stop_test');
  res.json({ message: "Ordre d'arrêt envoyé à l'ensemble du réseau." });
});

// --- ENDPOINT HTTP : LISTER LES WORKERS ---
app.get('/api/workers', (req, res) => {
  res.json(Array.from(workersRegistry.values()));
});


// --- GESTION DU CANAL WEBSOCKET TEMPS RÉEL ---
io.on('connection', (socket) => {
  // Récupération de l'ID communiqué par le worker lors de sa phase de connexion (auth)
  const workerId = socket.handshake.auth.workerId;

  if (!workerId) {
    console.warn(`[Orchestrateur] Connexion refusée : aucun ID de worker fourni (Socket: ${socket.id})`);
    return socket.disconnect(true);
  }

  console.log(`[Orchestrateur] Worker connecté : ${workerId} (Socket: ${socket.id})`);

  // Enregistrement par défaut du worker à l'état Disponible
  workersRegistry.set(workerId, {
    id: workerId,
    socketId: socket.id,
    status: 'AVAILABLE'
  });

  // Événement : Le worker confirme qu'il est prêt et partage son statut initial
  socket.on('worker:ready', (data) => {
    const worker = workersRegistry.get(workerId);
    if (worker) {
      worker.status = data.status || 'AVAILABLE';
      console.log(`[Orchestrateur] Worker ${workerId} synchronisé. Statut actuel : ${worker.status}`);
    }
  });

  // Événement : Changement de statut (ex: AVAILABLE -> BUSY au début du k6)
  socket.on('worker:status_changed', (data) => {
    const worker = workersRegistry.get(workerId);
    if (worker) {
      worker.status = data.status;
      console.log(`[Orchestrateur] Changement de statut pour ${workerId} -> ${data.status}`);
    }
  });

  // Événement : Réception des logs de la console k6 en temps réel
  socket.on('worker:log', (data) => {
    // C'est ici que vous pouvez rediriger les logs vers une UI web, un fichier, ou votre terminal
    const prefix = `[LOG][${workerId}][${data.type.toUpperCase()}]`;
    console.log(`${prefix} ${data.output.trim()}`);
  });

  // Événement : k6 a fini son travail sur ce nœud
  socket.on('worker:test_finished', (data) => {
    console.log(`[Orchestrateur] Le worker ${workerId} a complété son test (Code de sortie k6 : ${data.exitCode})`);
  });

  // Événement : Le worker a rencontré une erreur logicielle interne
  socket.on('worker:error', (data) => {
    console.error(`[Orchestrateur][ERREUR] Signalement de ${workerId} :`, data.message);
  });

  // Événement : Perte de connexion ou arrêt de l'agent
  socket.on('disconnect', () => {
    console.log(`[Orchestrateur] Worker déconnecté : ${workerId}`);
    workersRegistry.delete(workerId);
  });
});

// Lancement du serveur d'orchestration
httpServer.listen(PORT, () => {
  console.log(`\x1b[32m%s\x1b[0m`, `[Orchestrateur] Serveur démarré sur le port ${PORT}`);
  console.log(`[Orchestrateur] En attente de connexions de workers sur le protocole ws://...`);
});
