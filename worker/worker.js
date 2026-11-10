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

const app = express();
let currentK6Process = null;
let isRunning = false;

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

  // 3. Construction sécurisée de l'environnement
  const k6Env = {
    ...process.env,
    ...envVariables,
    K6_NO_USAGE_REPORT: 'true' // Optionnel : désactive le ping télémétrique de k6
  };

  // 4. Lancement isolé de k6 (shell: false empêche l'évaluation de chaînes malveillantes)
  // Détecter si on est sur Windows pour utiliser 'k6.exe' au lieu de 'k6'
  const k6Binary = os.platform() === 'win32' ? 'k6.exe' : 'k6';

  currentK6Process = spawn(k6Binary, [
    'run',
    '--vus', safeVus,
    '--duration', safeDuration,
    SCRIPT_TMP_PATH
  ], { 
    shell: false,
    env: k6Env
  });

  console.log(`[Worker] Processus k6 démarré (PID: ${currentK6Process.pid})`);

  // 5. Streaming des logs stdout et stderr en temps réel
  currentK6Process.stdout.on('data', (data) => {
    socket.emit('worker:log', { type: 'stdout', output: data.toString() });
  });

  currentK6Process.stderr.on('data', (data) => {
    socket.emit('worker:log', { type: 'stderr', output: data.toString() });
  });

  // 6. Gestion de la fin naturelle ou de l'erreur du processus
  currentK6Process.on('error', (err) => {
    console.error('[Worker] Erreur système lors de l\'exécution de k6:', err);
    socket.emit('worker:log', { type: 'stderr', output: `Erreur interne du binaire k6 : ${err.message}` });
  });

  currentK6Process.on('close', (code) => {
    console.log(`[Worker] Processus k6 terminé avec le code : ${code}`);
    
    // Nettoyage du fichier temporaire
    try {
      if (fs.existsSync(SCRIPT_TMP_PATH)) fs.unlinkSync(SCRIPT_TMP_PATH);
    } catch (e) {
      console.warn('[Worker] Impossible de supprimer le script temporaire:', e.message);
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
