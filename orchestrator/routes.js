// HTTP API (controllers) of the orchestrator.
//
//   POST /api/test/start       start a distributed test (pasted script or by path)
//   POST /api/test/stop       emergency stop (broadcast to every worker)
//   GET  /api/workers         known workers
//   GET  /api/test/sessions   session history ("Report" strip)
//   GET  /api/test/report     report of a session (JSON / TXT / HTML)
//   GET  /api/raw-metrics     raw k6 JSON of a worker (ndjson)
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
import { MAX_ATTACHMENTS_TOTAL_BYTES } from './constants.js';
import { parseDurationSeconds, formatSeconds } from './utils.js';
import { buildJsonReport } from './reports/json.js';
import { buildTxtReport } from './reports/txt.js';
import { buildHtmlReport } from './reports/html.js';

export function registerRoutes(app, io) {
  app.post('/api/test/start', (req, res) => {
    const { scriptContent, scriptPath, totalVus, duration, startVUs, stages, envVariables, workerIds, attachments } = req.body;

    // The script is pasted (`scriptContent`) or pointed to by a path (`scriptPath`):
    // the .js file is read on the orchestrator's machine (absolute path, or
    // relative to the orchestrator directory), then injected as-is to the workers.
    let content = scriptContent;
    const p = typeof scriptPath === 'string' ? scriptPath.trim() : '';
    if (p) {
      let text;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch (e) {
        const code = e && e.code;
        const msg = code === 'ENOENT'
          ? `Script file not found: ${p}`
          : `Cannot read the script file (${code || (e && e.message)}): ${p}`;
        return res.status(400).json({ error: msg });
      }
      if (!text.trim()) {
        return res.status(400).json({ error: `The script file is empty: ${p}` });
      }
      content = text;
    }

    // Node.js module import: k6 would crash at init (an unreadable error in the
    // worker logs); we return an actionable explanation here.
    const nodeBuiltin = findNodeBuiltinImport(content);
    if (nodeBuiltin) {
      return res.status(400).json({
        error: `The script imports the Node.js module '${nodeBuiltin}': not possible under k6 (a sandbox with no Node.js APIs). A k6 script can only import k6 modules (k6, k6/metrics, k6/html, k6/crypto, k6/csv, k6/experimental/oracle). To load data, pass it via environment variables, via k6/csv (URL), or inline it in the script.`
      });
    }

    // The load profile is either constant (totalVus + duration) or ramping (startVUs + stages).
    const isRamping = Array.isArray(stages) && stages.length > 0;
    if (!content) {
      return res.status(400).json({ error: 'Missing script (scriptContent or scriptPath).' });
    }
    if (isRamping) {
      for (const st of stages) {
        if (!st || !/^[0-9]+[smh]$/.test(String(st.duration)) || !/^[0-9]+$/.test(String(st.target))) {
          return res.status(400).json({ error: `Invalid stage: ${JSON.stringify(st)}. Each stage needs a "duration" (e.g. "2m") and an integer "target" (VUs).` });
        }
      }
    } else if (!totalVus || !duration) {
      return res.status(400).json({ error: 'Missing parameters: "totalVus" + "duration" (constant-vus) or "stages" (ramping-vus).' });
    }

    // Data files (CSV, etc.) referenced by relative path in the script
    // (e.g. `open('./data.csv')`): sent to every targeted worker and written
    // next to the ephemeral script, so the path resolves like a local run.
    let dataFiles = null;
    if (attachments) {
      if (typeof attachments !== 'object' || Array.isArray(attachments)) {
        return res.status(400).json({ error: '`attachments` must be an object: { "data.csv": "<base64>" }.' });
      }
      const entries = Object.entries(attachments);
      if (entries.length > 20) {
        return res.status(400).json({ error: 'At most 20 data files per test.' });
      }
      dataFiles = {};
      let total = 0;
      for (const [rawName, b64] of entries) {
        const name = String(rawName).trim();
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
          return res.status(400).json({ error: `Invalid data file name: '${rawName}'.` });
        }
        if (typeof b64 !== 'string' || !b64) {
          return res.status(400).json({ error: `Data file '${name}': the content must be a base64 string.` });
        }
        total += Math.floor((b64.length * 3) / 4);
        if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
          return res.status(413).json({ error: `Data files too large (${MAX_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)} MB total cap).` });
        }
        dataFiles[name] = b64;
      }
    }

    if (getCurrentSession()) {
      return res.status(409).json({
        error: `A test is already running (${getCurrentSession().id}). Stop it first via /api/test/stop.`
      });
    }

    // Targeted workers: explicit selection (`workerIds`), or by default every available worker
    let selected = null;
    if (Array.isArray(workerIds)) {
      selected = workerIds.map((w) => String(w).trim()).filter(Boolean);
    } else if (typeof workerIds === 'string' && workerIds.trim()) {
      selected = workerIds.split(',').map((w) => w.trim()).filter(Boolean);
    }
    if (selected && selected.length === 0) {
      return res.status(422).json({ error: 'No worker selected.' });
    }

    let targetWorkers;
    if (selected) {
      const ids = [...new Set(selected)];
      for (const id of ids) {
        const w = workersRegistry.get(id);
        if (!w) {
          return res.status(400).json({ error: `Unknown worker: ${id}` });
        }
        if (w.status !== 'AVAILABLE') {
          return res.status(422).json({ error: `Worker not available at the moment: ${id}` });
        }
      }
      targetWorkers = ids.map((id) => workersRegistry.get(id));
    } else {
      targetWorkers = Array.from(workersRegistry.values()).filter((w) => w.status === 'AVAILABLE');
    }

    if (targetWorkers.length === 0) {
      return res.status(422).json({ error: 'No worker is available at the moment.' });
    }

    // Fair distribution of the Virtual Users (VUs) over the targeted workers.
    // `share` splits an integer `total` over `workersCount` workers: the first worker
    // takes the remainder of the division, so the shares always sum back to `total`.
    const workersCount = targetWorkers.length;
    const share = (total, index) => Math.floor(total / workersCount) + (index === 0 ? total % workersCount : 0);

    // Session-level totals: the peak VUs and the overall duration of the profile.
    const sessionTotalVus = isRamping ? Math.max(...stages.map((s) => s.target)) : totalVus;
    const sessionDuration = isRamping
      ? formatSeconds(stages.reduce((acc, s) => acc + parseDurationSeconds(s.duration), 0))
      : duration;

    const session = createSession({ totalVus: sessionTotalVus, duration: sessionDuration });

    // Send the tailored start order to each targeted worker
    targetWorkers.forEach((worker, index) => {
      // The first worker takes the remainder of the division, if there is one
      const profile = isRamping
        ? {
            startVUs: share(startVUs || 0, index),
            stages: stages.map((s) => ({ duration: s.duration, target: share(s.target, index) }))
          }
        : { vus: share(totalVus, index), duration };

      // The worker's peak VUs (a worker with none is not targeted)
      const workerPeak = isRamping ? Math.max(...profile.stages.map((s) => s.target)) : profile.vus;
      if (workerPeak <= 0) return; // This worker has no VU to run: it is not targeted

      session.workers.set(worker.id, { exitCode: null, finishedAt: null, error: null });
      console.log(`[Orchestrator] Sending the sub-test to worker ${worker.id} (${workerPeak} peak VUs)`);

      io.to(worker.socketId).emit('orchestrator:start_test', {
        scriptContent: content,
        ...profile,
        envVariables: {
          ...envVariables,
          ORCHESTRATOR_WORKER_ID: worker.id
        },
        attachments: dataFiles
      });
    });

    if (session.workers.size === 0) {
      sessions.shift(); // Discard the empty session
      setCurrentSession(null);
      return res.status(422).json({
        error: 'Distribution impossible: the total VUS is lower than the number of targeted workers.'
      });
    }

    broadcastSession(io, session);
    broadcastWorkers(io);
    console.log(`[Orchestrator] Starting a distributed test on ${session.workers.size} worker(s) — session ${session.id}`);

    res.json({
      message: 'Distributed test initialized successfully',
      sessionId: session.id,
      workersCibles: session.workers.size,
      workerIds: [...session.workers.keys()]
    });
  });

  app.post('/api/test/stop', (req, res) => {
    console.log('[Orchestrator] Emergency stop request sent to every worker.');
    io.emit('orchestrator:stop_test');
    res.json({ message: 'Stop order sent to the whole network.' });
  });

  app.get('/api/workers', (req, res) => {
    res.json(Array.from(workersRegistry.values()));
  });

  app.get('/api/test/sessions', (req, res) => {
    res.json(sessionsSummary());
  });

  // Returns the session report: JSON (series + stats + logs) or TXT (summary)
  app.get('/api/test/report', (req, res) => {
    const id = req.query.session;
    const fmt = String(req.query.format || 'json').toLowerCase();
    const session = id
      ? sessions.find((s) => s.id === id)
      : (getCurrentSession() || sessions[0]);

    if (!session) {
      return res.status(404).json({ error: 'No test session found.' });
    }

    if (fmt === 'txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="k6-summary-${session.id}.txt"`);
      return res.send(buildTxtReport(session));
    }

    if (fmt === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="k6-report-${session.id}.html"`);
      return res.send(buildHtmlReport(session));
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="k6-report-${session.id}.json"`);
    res.send(JSON.stringify(buildJsonReport(session), null, 2));
  });

  // RAW k6 JSON output of a worker (content of `--out json=`, one JSON line per data point)
  app.get('/api/raw-metrics', (req, res) => {
    const id = req.query.session;
    const workerId = req.query.worker;
    const session = id
      ? sessions.find((s) => s.id === id)
      : (getCurrentSession() || sessions[0]);

    if (!session) {
      return res.status(404).json({ error: 'No test session found.' });
    }

    const lines = session.rawMetrics.get(workerId);
    if (!workerId || !lines || lines.length === 0) {
      return res.status(404).json({ error: 'No raw data points for this worker (no --out json= received).' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="k6-out-${session.id}-${workerId}.jsonl"`);
    res.send(lines.join('\n') + '\n');
  });
}