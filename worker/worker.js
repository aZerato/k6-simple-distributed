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
// Temporary file that receives the raw k6 metrics (`--out json=`),
// re-read line by line and streamed to the orchestrator for the charts.
const METRICS_TMP_PATH = path.join(os.tmpdir(), `k6_metrics_${WORKER_ID}.json`);

const app = express();
let currentK6Process = null;
let isRunning = false;

// --- Metrics streaming state ---
let metricsOffset = 0;      // read position in the metrics file
let metricsPending = '';   // last unfinished line fragment
let metricsBuffer = [];   // lines waiting to be sent
let metricsTimer = null;  // periodic drain interval
const MAX_BUFFERED_METRICS = 100000; // safety cap if the orchestrator is unreachable

// --- HTTP ENDPOINT FOR HEALTH CHECKS ---
app.get('/health', (req, res) => {
  res.json({
    workerId: WORKER_ID,
    status: isRunning ? 'BUSY' : 'AVAILABLE',
    k6Running: currentK6Process !== null
  });
});

const server = app.listen(HTTP_PORT, () => {
  console.log(`[Worker] Standby HTTP server started on port ${HTTP_PORT}`);
});

// --- REAL-TIME CONNECTION TO THE ORCHESTRATOR (WEBSOCKET) ---
console.log(`[Worker] Connecting to the orchestrator on ${ORCHESTRATOR_URL}...`);
const socket = io(ORCHESTRATOR_URL, {
  auth: { workerId: WORKER_ID },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 2000
});

socket.on('connect', () => {
  console.log(`[Worker] Connected successfully to the orchestrator with ID: ${WORKER_ID}`);
  socket.emit('worker:ready', { status: isRunning ? 'BUSY' : 'AVAILABLE' });
});

socket.on('disconnect', () => {
  console.warn('[Worker] Disconnected from the orchestrator. Attempting to reconnect...');
});

// --- k6 METRICS STREAMING (the `--out json=` file) ---
function drainMetricsFile() {
  if (!isRunning) return;
  let st;
  try { st = fs.statSync(METRICS_TMP_PATH); } catch { return; } // file does not exist yet
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
  metricsPending = parts.pop(); // keep the potentially incomplete fragment
  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    let item;
    try { item = JSON.parse(line); } catch {
      console.warn(`[Worker] Unreadable metrics line, ignored: ${line.slice(0, 120)}`);
      continue;
    }
    metricsBuffer.push(item);
  }

  if (socket.connected) {
    if (metricsBuffer.length) socket.emit('worker:metrics', { data: metricsBuffer.splice(0) });
  } else if (metricsBuffer.length > MAX_BUFFERED_METRICS) {
    // The orchestrator is offline: keep only the latest values so we do not saturate the RAM
    console.warn('[Worker] Metrics buffer saturated (orchestrator unreachable) — oldest values dropped.');
    metricsBuffer.splice(0, metricsBuffer.length - MAX_BUFFERED_METRICS);
  }
}

// --- INBOUND: TEST START ORDER ---
socket.on('orchestrator:start_test', (payload) => {
  if (isRunning) {
    return socket.emit('worker:error', { message: 'The worker is already busy with a test.' });
  }

  const { scriptContent, vus, duration, envVariables } = payload;

  if (!scriptContent) {
    return socket.emit('worker:error', { message: 'The k6 script content is missing.' });
  }

  // 1. Strict validation of the arguments to forbid command injection
  const safeVus = String(parseInt(vus, 10) || 1);
  const safeDuration = /^[0-9]+[smh]$/.test(duration) ? duration : '10s';

  console.log(`[Worker] Preparing the k6 test (${safeVus} VUs, ${safeDuration})`);
  isRunning = true;
  socket.emit('worker:status_changed', { status: 'BUSY' });

  // 2. Secure writing of the ephemeral k6 script
  try {
    fs.writeFileSync(SCRIPT_TMP_PATH, scriptContent, 'utf-8');
  } catch (err) {
    console.error('[Worker] Failed to write the temporary script', err);
    isRunning = false;
    socket.emit('worker:status_changed', { status: 'AVAILABLE' });
    return socket.emit('worker:error', { message: 'Could not initialize the script file.' });
  }

  // 3. Metrics streaming preparation (empty file + zeroed offsets)
  try { fs.unlinkSync(METRICS_TMP_PATH); } catch { /* first run */ }
  metricsOffset = 0;
  metricsPending = '';
  metricsBuffer = [];

  // 4. Secure construction of the environment
  const k6Env = {
    ...process.env,
    ...envVariables,
    K6_NO_USAGE_REPORT: 'true' // Optional: disables k6's telemetry ping
  };

  // 5. Isolated launch of k6 (shell: false prevents the evaluation of malicious strings)
  //    `--out json=`: the raw data points are written to a file,
  //    which we re-read line by line to feed the console charts.
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

  console.log(`[Worker] k6 process started (PID: ${currentK6Process.pid})`);

  // Periodic drain of the metrics file toward the orchestrator
  metricsTimer = setInterval(drainMetricsFile, 500);

  // 6. Real-time streaming of the stdout and stderr logs
  currentK6Process.stdout.on('data', (data) => {
    socket.emit('worker:log', { type: 'stdout', output: data.toString() });
  });

  currentK6Process.stderr.on('data', (data) => {
    socket.emit('worker:log', { type: 'stderr', output: data.toString() });
  });

  // 7. Handling of the natural end or of an error of the process
  currentK6Process.on('error', (err) => {
    console.error('[Worker] System error while running k6:', err);
    socket.emit('worker:log', { type: 'stderr', output: `Internal error of the k6 binary: ${err.message}` });
  });

  currentK6Process.on('close', (code) => {
    console.log(`[Worker] k6 process finished with code: ${code}`);

    // Final drain, then stop the metrics streaming
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    drainMetricsFile();

    // Cleanup of the temporary files
    for (const p of [SCRIPT_TMP_PATH, METRICS_TMP_PATH]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (e) {
        console.warn(`[Worker] Could not delete ${p}:`, e.message);
      }
    }

    currentK6Process = null;
    isRunning = false;

    // End notification to the orchestrator
    socket.emit('worker:test_finished', { exitCode: code });
    socket.emit('worker:status_changed', { status: 'AVAILABLE' });
  });
});

// --- INBOUND: EMERGENCY STOP ORDER ---
socket.on('orchestrator:stop_test', () => {
  if (!currentK6Process) {
    return console.log('[Worker] No test in progress to stop.');
  }

  console.log(`[Worker] Forced stop requested for the k6 process (PID: ${currentK6Process.pid})`);
  // Send a SIGINT signal to k6 so it stops gracefully (or SIGKILL if necessary)
  currentK6Process.kill('SIGINT');
});

// --- CLEANUP ON WORKER SHUTDOWN ---
process.on('SIGTERM', () => {
  if (currentK6Process) currentK6Process.kill('SIGKILL');
  server.close();
  process.exit(0);
});
