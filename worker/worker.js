import express from 'express';
import { io } from 'socket.io-client';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- CONFIGURATION ---
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';
const WORKER_ID = process.env.WORKER_ID || `worker-${Math.random().toString(36).substring(2, 9)}`;
const HTTP_PORT = process.env.PORT || 4000;
const SCRIPT_TMP_PATH = path.join(os.tmpdir(), `k6_script_${WORKER_ID}.js`);
// Fichier temporaire qui reçoit les métriques brutes de k6 (`--out json=`),
// relu ligne à ligne puis streamé vers l'orchestrateur pour les graphiques.
const METRICS_TMP_PATH = path.join(os.tmpdir(), `k6_metrics_${WORKER_ID}.json`);

const app = express();
let currentK6Process = null;
let isRunning = false;

// --- État du streaming des métriques ---
let metricsOffset = 0;      // position de lecture dans le fichier de métriques
let metricsPending = '';   // dernier fragment de ligne non terminé
let metricsBuffer = [];   // lignes en attente d'envoi
let metricsTimer = null;  // intervalle de vidange périodique
const MAX_BUFFERED_METRICS = 100000; // garde-fou si l'orchestrateur est injoignable

// --- EXPOSE UN ENDPOINT HTTP POUR LES BILANS DE SANTÉ (HEALTHCHECK) ---
app.get('/health', (req, res) => {
  res.json({
    workerId: WORKER_ID,
    status: isRunning ? 'BUSY' : 'AVAILABLE',
    k6Running: currentK6Process !== null
  });
});

const server = app.listen(HTTP_PORT, () => {
  console.log(`[Worker] Serveur HTTP d'appoint démarré sur le port ${HTTP_PORT}`);
});

// --- CONNEXION TEMPS RÉEL À L'ORCHESTRATEUR (WEBSOCKET) ---
console.log(`[Worker] Connexion à l'orchestrateur sur ${ORCHESTRATOR_URL}...`);
const socket = io(ORCHESTRATOR_URL, {
  auth: { workerId: WORKER_ID },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 2000
});

socket.on('connect', () => {
  console.log(`[Worker] Connecté avec succès à l'orchestrateur sous l'ID : ${WORKER_ID}`);
  socket.emit('worker:ready', { status: isRunning ? 'BUSY' : 'AVAILABLE' });
});

socket.on('disconnect', () => {
  console.warn('[Worker] Déconnecté de l\'orchestrateur. Tentative de reconnexion...');
});

// --- STREAMING DES MÉTRIQUES k6 (fichier `--out json=`) ---
function drainMetricsFile() {
  if (!isRunning) return;
  let st;
  try { st = fs.statSync(METRICS_TMP_PATH); } catch { return; } // pas encore de fichier
  if (st.size <= metricsOffset) return;

  const fd = fs.openSync(METRICS_TMP_PATH, 'r');
  const buf = Buffer.alloc(st.size - metricsOffset);
  try {
    fs.readSync(fd, buf, 0, buf.length, metricsOffset);
  } finally {
    fs.closeSync(fd);
  }
  metricsOffset = st.size;

  const text = metricsPending + buf.toString('utf-8');
  const parts = text.split('\n');
  metricsPending = parts.pop(); // conserve le fragment éventuellement incomplet
  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    let item;
    try { item = JSON.parse(line); } catch {
      console.warn(`[Worker] Ligne de métriques illisible, ignorée : ${line.slice(0, 120)}`);
      continue;
    }
    metricsBuffer.push(item);
  }

  if (socket.connected) {
    if (metricsBuffer.length) socket.emit('worker:metrics', { data: metricsBuffer.splice(0) });
  } else if (metricsBuffer.length > MAX_BUFFERED_METRICS) {
    // L'orchestrateur est hors ligne : on garde les dernières valeurs pour ne pas saturer la RAM
    console.warn('[Worker] Buffer de métriques saturé (orchestrateur injoignable) — anciennes valeurs abandonnées.');
    metricsBuffer.splice(0, metricsBuffer.length - MAX_BUFFERED_METRICS);
  }
}

// --- ENTRÉE : ORDRE DE LANCEMENT D'UN TEST ---
socket.on('orchestrator:start_test', (payload) => {
  if (isRunning) {
    return socket.emit('worker:error', { message: 'Le worker est déjà occupé par un test.' });
  }

  const { scriptContent, vus, duration, envVariables } = payload;

  if (!scriptContent) {
    return socket.emit('worker:error', { message: 'Le contenu du script k6 est manquant.' });
  }

  // 1. Validation stricte des arguments pour interdire l'injection de commandes
  const safeVus = String(parseInt(vus, 10) || 1);
  const safeDuration = /^[0-9]+[smh]$/.test(duration) ? duration : '10s';

  console.log(`[Worker] Préparation du test k6 (${safeVus} VUs, ${safeDuration})`);
  isRunning = true;
  socket.emit('worker:status_changed', { status: 'BUSY' });

  // 2. Écriture sécurisée du script k6 éphémère
  try {
    fs.writeFileSync(SCRIPT_TMP_PATH, scriptContent, 'utf-8');
  } catch (err) {
    console.error('[Worker] Échec d\'écriture du script temporaire', err);
    isRunning = false;
    socket.emit('worker:status_changed', { status: 'AVAILABLE' });
    return socket.emit('worker:error', { message: 'Impossible d\'initialiser le fichier de script.' });
  }

  // 3. Préparation du streaming des métriques (fichier vide + offsets à zéro)
  try { fs.unlinkSync(METRICS_TMP_PATH); } catch { /* première exécution */ }
  metricsOffset = 0;
  metricsPending = '';
  metricsBuffer = [];

  // 4. Construction sécurisée de l'environnement
  const k6Env = {
    ...process.env,
    ...envVariables,
    K6_NO_USAGE_REPORT: 'true' // Optionnel : désactive le ping télémétrique de k6
  };

  // 5. Lancement isolé de k6 (shell: false empêche l'évaluation de chaînes malveillantes)
  //    `--out json=` : les points de données bruts sont écrits dans un fichier,
  //    qu'on relu ligne à ligne pour alimenter les graphiques de la console.
  const k6Binary = os.platform() === 'win32' ? 'k6.exe' : 'k6';

  currentK6Process = spawn(k6Binary, [
    'run',
    '--vus', safeVus,
    '--duration', safeDuration,
    '--out', `json=${METRICS_TMP_PATH}`,
    SCRIPT_TMP_PATH
  ], {
    shell: false,
    env: k6Env
  });

  console.log(`[Worker] Processus k6 démarré (PID: ${currentK6Process.pid})`);

  // Vidange périodique du fichier de métriques vers l'orchestrateur
  metricsTimer = setInterval(drainMetricsFile, 500);

  // 6. Streaming des logs stdout et stderr en temps réel
  currentK6Process.stdout.on('data', (data) => {
    socket.emit('worker:log', { type: 'stdout', output: data.toString() });
  });

  currentK6Process.stderr.on('data', (data) => {
    socket.emit('worker:log', { type: 'stderr', output: data.toString() });
  });

  // 7. Gestion de la fin naturelle ou de l'erreur du processus
  currentK6Process.on('error', (err) => {
    console.error('[Worker] Erreur système lors de l\'exécution de k6:', err);
    socket.emit('worker:log', { type: 'stderr', output: `Erreur interne du binaire k6 : ${err.message}` });
  });

  currentK6Process.on('close', (code) => {
    console.log(`[Worker] Processus k6 terminé avec le code : ${code}`);

    // Vidange finale puis arrêt du streaming des métriques
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    drainMetricsFile();

    // Nettoyage des fichiers temporaires
    for (const p of [SCRIPT_TMP_PATH, METRICS_TMP_PATH]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (e) {
        console.warn(`[Worker] Impossible de supprimer ${p}:`, e.message);
      }
    }

    currentK6Process = null;
    isRunning = false;

    // Notification de fin à l'orchestrateur
    socket.emit('worker:test_finished', { exitCode: code });
    socket.emit('worker:status_changed', { status: 'AVAILABLE' });
  });
});

// --- ENTRÉE : ORDRE D'ARRÊT D'URGENCE (STOP) ---
socket.on('orchestrator:stop_test', () => {
  if (!currentK6Process) {
    return console.log('[Worker] Aucun test en cours à arrêter.');
  }

  console.log(`[Worker] Arrêt forcé demandé pour le processus k6 (PID: ${currentK6Process.pid})`);
  // Envoi d'un signal SIGINT à k6 pour qu'il s'arrête proprement (ou SIGKILL si nécessaire)
  currentK6Process.kill('SIGINT');
});

// --- NETTOYAGE LORS DE LA FERMETURE DU WORKER ---
process.on('SIGTERM', () => {
  if (currentK6Process) currentK6Process.kill('SIGKILL');
  server.close();
  process.exit(0);
});
