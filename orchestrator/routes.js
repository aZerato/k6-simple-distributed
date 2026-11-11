// API HTTP (controllers) de l'orchestrateur.
//
//   POST /api/test/start       lancer un test distribué (script collé ou par chemin)
//   POST /api/test/stop       arrêt d'urgence (diffusé à tous les workers)
//   GET  /api/workers         workers connus
//   GET  /api/test/sessions   historique des sessions (bandeau « Rapport »)
//   GET  /api/test/report     rapport d'une session (JSON / TXT / HTML)
//   GET  /api/raw-metrics     JSON brut k6 d'un worker (ndjson)
import fs from 'fs';
import {
  workersRegistry,
  sessions,
  getCurrentSession,
  setCurrentSession,
  createSession,
  sessionsSummary,
  broadcastSession,
  broadcastWorkers
} from './state.js';
import { findNodeBuiltinImport } from './scripts.js';
import { buildJsonReport } from './reports/json.js';
import { buildTxtReport } from './reports/txt.js';
import { buildHtmlReport } from './reports/html.js';

export function registerRoutes(app, io) {
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

    if (getCurrentSession()) {
      return res.status(409).json({
        error: `Un test est déjà en cours (${getCurrentSession().id}). Arrêtez-le d'abord via /api/test/stop.`
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
      setCurrentSession(null);
      return res.status(422).json({
        error: 'Répartition impossible : les VUS totales sont inférieures au nombre de workers disponibles.'
      });
    }

    broadcastSession(io, session);
    broadcastWorkers(io);
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
      : (getCurrentSession() || sessions[0]);

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

  // Sortie JSON BRUTE de k6 d'un worker (contenu du `--out json=`, une ligne JSON par point de données)
  app.get('/api/raw-metrics', (req, res) => {
    const id = req.query.session;
    const workerId = req.query.worker;
    const session = id
      ? sessions.find((s) => s.id === id)
      : (getCurrentSession() || sessions[0]);

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
}
