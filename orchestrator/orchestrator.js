// Point d'entrée de l'orchestrateur k6 distribué.
//
// Le code est découpé par responsabilité (lisible « par controller / socket ») :
//
//   constants.js   plafonds mémoire / console
//   utils.js       formatage (dates, octets)
//   state.js       registre en mémoire : workers + sessions (source de vérité)
//   metrics.js     agrégation des métriques k6 + snapshot par seconde
//   workers.js     événements workers : logs k6 + fin de test
//   scripts.js     validation du script k6 (détect. imports Node.js)
//   reports/       rapports de session (JSON, TXT, HTML autoporté)
//   routes.js      API HTTP (controllers)
//   sockets.js     canal Socket.io (workers + console web)
//
// Ce fichier ne fait que les assembler : express + socket.io + écoute.
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerRoutes } from './routes.js';
import { registerSockets } from './sockets.js';
import { startMetricsTicker } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
// Configuration de Socket.io avec CORS ouvert pour laisser les workers se connecter
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
// Console web : le build Next.js (web/out) s'il a été généré,
// sinon la console legacy (public/). Mêmes origines pour HTTP + Socket.io.
const nextOut = path.join(__dirname, '..', 'web', 'out');
const staticDir = fs.existsSync(nextOut) ? nextOut : path.join(__dirname, 'public');
app.use(express.static(staticDir));

// Câblage : API HTTP + canal Socket.io + snapshot des métriques (1/s)
registerRoutes(app, io);
registerSockets(io);
startMetricsTicker(io);

// Lancement du serveur d'orchestration
httpServer.listen(PORT, () => {
  console.log(`\x1b[32m%s\x1b[0m`, `[Orchestrateur] Serveur démarré sur le port ${PORT}`);
  console.log(`[Orchestrateur] Console web disponible sur http://localhost:${PORT}`);
  console.log('[Orchestrateur] En attente de connexions de workers sur le protocole socket.io...');
});
