'use client';
/* ============================================================
   useDashboard — the "brain" of the console
   (React port of public/app.js: socket + view state)

   - socket.io connection to the orchestrator (ui:* events)
   - view state: displayed session / "pinned" session / RUNNING session
   - rows (ui:metrics snapshots), series per worker, logs per worker
   - "forced refresh" watchdog (1/s)
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_BASE, ORCHESTRATOR_URL, HISTORY_MAX, MAX_LOG_KEEP, SPARK_LEN } from '../lib/config';
import { timeLabel } from '../lib/format';
import {
  CARDS,
  CHART_DEFS,
  buildSeries,
  drawSeries,
  drawSpark,
  isSeriesOn,
  knownMetrics,
  metricDef,
  prep,
  chartIndexFromX,
  showChartTip,
  hideChartTip
} from '../lib/charts';

export function useDashboard() {
  /* ---------- refs (mutable state, stable closures) ---------- */

  const socketRef = useRef(null);
  const rowsRef = useRef([]); // snapshots (ui:metrics) of the displayed session
  const workerIdsRef = useRef([]); // workers that produced metrics (order of appearance)
  const seriesVisibleRef = useRef(new Map()); // series id -> visible
  const maxSeqRef = useRef(0); // deduplication of the replay
  const workerLogsRef = useRef(new Map()); // workerId -> [ { t, type, text } ]
  const activeWorkerRef = useRef(null); // selected logs tab
  const lastAppendedRef = useRef(null); // last appended line (animation)
  const clearedAtRef = useRef(0); // "Clear" button (epoch ms)
  const activeSessionIdRef = useRef(null); // displayed session (charts + logs)
  const userPinnedIdRef = useRef(null); // session chosen in the "Report" selector
  const runningSessionIdRef = useRef(null); // RUNNING session (from ui:session_state)
  const lastRowAtRef = useRef(0); // timestamp of the last snapshot received
  const lastResyncAtRef = useRef(0); // last forced replay (anti-loop safeguard)
  const stickRef = useRef(true); // "stuck" to the bottom of the logs?
  const hoverRef = useRef(null); // { redraw, index } — chart currently hovered
  const logviewRef = useRef(null);
  const tipRef = useRef(null);
  const canvasRefs = useRef({}); // key -> canvas element

  /* ---------- React state (rendering) ---------- */

  const [ledOn, setLedOn] = useState(false);
  const [workers, setWorkers] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [latestSession, setLatestSession] = useState(null);
  const [rowsRev, setRowsRev] = useState(0); // tick: the rows changed
  const [workerIds, setWorkerIds] = useState([]);
  const [metricNames, setMetricNames] = useState([]);
  const [metricName, setMetricName] = useState('');
  const [seriesVisible, setSeriesVisible] = useState(new Map());
  const [sessionSelectValue, setSessionSelectValue] = useState('');
  const [rawWorkerValue, setRawWorkerValue] = useState('');
  const [activeWorker, setActiveWorker] = useState(null);
  const [logRev, setLogRev] = useState(0); // tick: the logs changed
  const [totalLogLines, setTotalLogLines] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [formStatus, setFormStatus] = useState({ cls: '', text: '' });
  const [submitting, setSubmitting] = useState(false);

  const metricNameRef = useRef('');
  useEffect(() => { metricNameRef.current = metricName; }, [metricName]);
  useEffect(() => { seriesVisibleRef.current = seriesVisible; }, [seriesVisible]);

  /* ---------- Logs helpers ---------- */

  const nearBottom = () => {
    const el = logviewRef.current;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const scrollBottom = () => {
    const el = logviewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  /* ---------- Full view reset (session switch) ---------- */

  const resetAll = useCallback(() => {
    rowsRef.current = [];
    maxSeqRef.current = 0;
    workerIdsRef.current = [];
    workerLogsRef.current = new Map();
    activeWorkerRef.current = null;
    lastAppendedRef.current = null;
    clearedAtRef.current = 0;
    setWorkerIds([]);
    setMetricNames([]);
    setMetricName('');
    setSeriesVisible(new Map());
    setActiveWorker(null);
    setTotalLogLines(0);
    setLogRev((r) => r + 1);
    setRowsRev((r) => r + 1);
  }, []);

  /* ---------- Metrics: workers appeared + known metrics ---------- */

  // Does a worker emit metrics for the first time? (series update)
  const noteWorkers = (row) => {
    let changed = false;
    for (const wid of Object.keys(row.byWorker || {})) {
      if (!workerIdsRef.current.includes(wid)) {
        workerIdsRef.current.push(wid);
        changed = true;
      }
    }
    if (changed) setWorkerIds([...workerIdsRef.current]);
    return changed;
  };

  // Port of syncMetricSelect: keeps the selection if still valid, otherwise the first one.
  const syncMetricNames = () => {
    const names = knownMetrics(rowsRef.current);
    setMetricNames(names);
    setMetricName((cur) => (names.includes(cur) ? cur : names[0] || ''));
  };

  /* ---------- Sessions & reports (port of fillSelect / refreshSessions) ---------- */

  const setSessionsAndSelect = (list, forceId) => {
    const arr = list || [];
    setSessions(arr);
    setSessionSelectValue((cur) => {
      const valid = arr.some((x) => x.id === cur) ? cur : '';
      return forceId || valid || (arr[0] ? arr[0].id : '');
    });
  };

  const refreshSessions = (forceId) => {
    fetch(`${API_BASE}/api/test/sessions`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((list) => setSessionsAndSelect(list))
      .catch(() => { /* orchestrator temporarily unreachable */ });
    if (forceId) setSessionSelectValue(forceId);
  };

  /* ---------- Session state (port of applySessionState + setLatest) ---------- */

  const applySessionState = (s) => {
    if (!s) return;
    const hijack = s.status === 'RUNNING' && s.id !== activeSessionIdRef.current;
    if (s.status === 'RUNNING') runningSessionIdRef.current = s.id;
    else if (s.id === runningSessionIdRef.current) runningSessionIdRef.current = null;
    if (hijack) {
      // A new test is starting: the view switches back to it (even if the
      // user was looking at another session).
      userPinnedIdRef.current = null;
      activeSessionIdRef.current = s.id;
      resetAll();
    }
    setLatestSession(s);
    refreshSessions(hijack ? s.id : undefined);
  };

  /* ---------- Logs: appending a line ---------- */

  const appendLogLine = (entry) => {
    const { workerId, t, type, text } = entry;
    let arr = workerLogsRef.current.get(workerId);
    if (!arr) {
      arr = [];
      workerLogsRef.current.set(workerId, arr);
    }
    arr.push({ t, type, text });
    if (arr.length > MAX_LOG_KEEP) arr.shift();
    setTotalLogLines((n) => n + 1);
    lastAppendedRef.current = { workerId, line: arr[arr.length - 1] };

    // First line of a worker not yet followed: we activate it automatically
    if (!activeWorkerRef.current) {
      activeWorkerRef.current = workerId;
      setActiveWorker(workerId);
    }
    setLogRev((r) => r + 1);
  };

  /* ---------- Real-time socket ---------- */

  useEffect(() => {
    const socket = io(ORCHESTRATOR_URL || undefined);
    socketRef.current = socket;

    socket.on('connect', () => setLedOn(true));
    socket.on('disconnect', () => setLedOn(false));

    socket.on('ui:state', ({ workers: w, session, latestSession: ls, sessions: ss }) => {
      setWorkers(w || []);
      if (session) applySessionState(session);
      setLatestSession(ls);
      setSessionsAndSelect(ss);
    });

    // Replay of the logs already produced (late connection, or session selected in the "Report" strip)
    socket.on('ui:logs_replay', ({ session, workers }) => {
      if (session !== activeSessionIdRef.current) {
        // Switching the view to the requested session
        activeSessionIdRef.current = session;
        resetAll();
      }
      let first = null;
      let m = 0;
      for (const [id, lines] of Object.entries(workers)) {
        if (!first) first = id;
        const clean = lines.map((l) => ({ t: l.t, type: l.type, text: l.text }));
        workerLogsRef.current.set(id, clean);
        for (const l of lines) if (l.seq) m = Math.max(m, l.seq);
      }
      maxSeqRef.current = Math.max(maxSeqRef.current, m);
      const total = [...workerLogsRef.current.values()].reduce((a, l) => a + l.length, 0);
      setTotalLogLines(total);
      if (first) {
        activeWorkerRef.current = first;
        setActiveWorker(first);
      }
      setLogRev((r) => r + 1);
    });

    socket.on('ui:log', (l) => {
      if (l.session !== activeSessionIdRef.current) return;
      if (l.seq && l.seq <= maxSeqRef.current) return; // already replayed
      if (l.seq) maxSeqRef.current = l.seq;
      appendLogLine(l);
    });

    // Metrics snapshots (on-demand replay, then 1/s during the test)
    socket.on('ui:metrics_replay', ({ session, rows: replayRows }) => {
      if (session !== activeSessionIdRef.current) {
        activeSessionIdRef.current = session;
        resetAll();
      }
      rowsRef.current = replayRows || [];
      for (const r of rowsRef.current) noteWorkers(r);
      if (rowsRef.current.length) lastRowAtRef.current = Date.now();
      syncMetricNames();
      setRowsRev((r) => r + 1);
    });

    socket.on('ui:metrics', ({ session, running, row }) => {
      if (session !== activeSessionIdRef.current) {
        // The snapshot does not match the displayed session:
        //  - if the user chose a session in the "Report" selector,
        //    we stay on it (no automatic catch-up);
        //  - otherwise it is the live flow of the running test: we (re)switch
        //    to it, even if the start state was missed (reconnection, etc.).
        if (running && userPinnedIdRef.current === null) {
          activeSessionIdRef.current = session;
          resetAll();
          refreshSessions(session);
        } else {
          return;
        }
      }
      noteWorkers(row);
      rowsRef.current.push(row);
      lastRowAtRef.current = Date.now();
      if (rowsRef.current.length > HISTORY_MAX) rowsRef.current.shift();
      syncMetricNames();
      setRowsRev((r) => r + 1);
    });

    socket.on('ui:workers', (w) => setWorkers(w || []));
    socket.on('ui:session_state', applySessionState);

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- "Forced refresh" watchdog (1/s) ----------
     During a running test, if the live flow no longer reaches the view
     (failed reconnection, missed state, sleeping tab…), we ask the
     orchestrator for the history of the running session: the charts,
     cards and table become up to date again automatically. */
  useEffect(() => {
    const t = setInterval(() => {
      if (!runningSessionIdRef.current || userPinnedIdRef.current !== null || activeSessionIdRef.current !== runningSessionIdRef.current) return;
      const now = Date.now();
      if (now - lastResyncAtRef.current < 5000) return;
      const stale = lastRowAtRef.current === 0 ? now - lastResyncAtRef.current > 4000 : now - lastRowAtRef.current > 3500;
      if (!stale) return;
      lastResyncAtRef.current = now;
      socketRef.current && socketRef.current.emit('ui:show_session', { session: runningSessionIdRef.current });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  /* ---------- Init: session history ---------- */
  useEffect(() => {
    refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Drawing (port of drawCharts + updateCards) ---------- */

  const drawAll = useCallback(() => {
    const rows = rowsRef.current;
    const visible = seriesVisibleRef.current;
    const wids = workerIdsRef.current;
    const canvases = canvasRefs.current;

    for (const c of CHART_DEFS) {
      const el = canvases[c.key];
      if (el) drawSeries(el, c, { rows, workerIds: wids, visible });
    }
    const mel = canvases['metric'];
    if (mel) {
      if (!metricNameRef.current) prep(mel);
      else drawSeries(mel, metricDef(metricNameRef.current), { rows, workerIds: wids, visible });
    }
    // Is the cursor hovering a chart? We keep the marker stable during live refreshes
    if (hoverRef.current) hoverRef.current.redraw(hoverRef.current.index);

    // Summary cards: sparklines
    const vals = rows.slice(-SPARK_LEN);
    for (const c of CARDS) {
      const el = canvases['card-' + c.label];
      if (!el) continue;
      drawSpark(el, vals.map((row) => (c.spark(row) == null ? 0 : c.spark(row))), c.color);
    }
  }, []);

  /* ---------- Chart hovering (value at time t) ---------- */

  useEffect(() => {
    const tipEl = tipRef.current;
    if (!tipEl) return;
    const attach = (key, defFactory) => {
      const canvas = canvasRefs.current[key];
      if (!canvas) return;
      const getSeries = () => buildSeries(defFactory(), workerIdsRef.current);
      const redraw = (i) => {
        drawSeries(canvas, defFactory(), { rows: rowsRef.current, workerIds: workerIdsRef.current, visible: seriesVisibleRef.current, hoverIndex: i });
      };
      canvas.addEventListener('mousemove', (e) => {
        const n = rowsRef.current.length;
        if (n === 0) { hoverRef.current = null; hideChartTip(tipEl); return; }
        const rect = canvas.getBoundingClientRect();
        const i = chartIndexFromX(canvas, e.clientX - rect.left, n);
        hoverRef.current = i >= 0 ? { redraw, index: i } : null;
        if (i < 0) { hideChartTip(tipEl); return; }
        const r = rowsRef.current[i];
        // Value of ALL visible series at time t (merged + workers)
        const html = `<span class="tt">${timeLabel(r.t)}</span>` +
          getSeries().filter((s) => isSeriesOn(seriesVisibleRef.current, s.id)).map((s) => `<br>${s.label} : ${s.fmt(s.get(r))}`).join('');
        showChartTip(tipEl, e, html);
      });
      canvas.addEventListener('mouseleave', () => {
        hoverRef.current = null;
        hideChartTip(tipEl);
      });
    };
    for (const c of CHART_DEFS) attach(c.key, () => c);
    attach('metric', () => metricDef(metricNameRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Controls: form, stop, clear, downloads ---------- */

  const submitTest = async ({ scriptPath, scriptContent, totalVus, duration, workerIds }) => {
    setSubmitting(true);
    setFormStatus({ cls: '', text: 'Sending…' });
    // The script is either pasted or pointed to by a .js file (read by the orchestrator)
    if (!scriptPath && !scriptContent) {
      setFormStatus({ cls: 'err', text: 'No script: paste k6 code or point to a .js file.' });
      setSubmitting(false);
      return;
    }
    // Explicit worker selection: `workerIds` is the list of checked workers
    // (the whole list when none was provided, e.g. an old console / API client).
    if (workerIds && workerIds.length === 0) {
      setFormStatus({ cls: 'err', text: 'No worker selected: tick at least one worker in the form.' });
      setSubmitting(false);
      return;
    }
    const payload = { totalVus, duration };
    if (workerIds) payload.workerIds = workerIds;
    if (scriptPath) payload.scriptPath = scriptPath;
    else payload.scriptContent = scriptContent;
    try {
      const res = await fetch(`${API_BASE}/api/test/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // The view immediately switches to the new session, without waiting for the socket state
      userPinnedIdRef.current = null;
      activeSessionIdRef.current = data.sessionId;
      resetAll();
      // Forced refresh: the orchestrator replays the session history -> the
      // charts, cards and table are guaranteed up to date from the restart.
      socketRef.current && socketRef.current.emit('ui:show_session', { session: data.sessionId });
      refreshSessions(data.sessionId);
      setFormStatus({
        cls: 'ok',
        text: `${scriptPath ? `File: ${scriptPath} — ` : ''}Test started — ${data.workersCibles} worker(s) targeted, session ${data.sessionId}.`
      });
    } catch (err) {
      setFormStatus({ cls: 'err', text: err.message });
    } finally {
      setSubmitting(false);
    };
  };

  const stopTest = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/test/stop`, { method: 'POST' });
      const data = await res.json();
      setFormStatus({ cls: 'ok', text: data.message });
    } catch {
      setFormStatus({ cls: 'err', text: 'Could not send the stop order.' });
    }
  };

  const clearLogs = () => {
    // "Clear": purges the view only (the per-worker memory is kept,
    // as in the legacy console).
    clearedAtRef.current = Date.now();
    setLogRev((r) => r + 1);
  };

  const triggerDownload = (href) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const downloadReport = (fmt) => {
    const id = sessionSelectValue;
    if (!id) return;
    triggerDownload(`${API_BASE}/api/test/report?session=${encodeURIComponent(id)}&format=${fmt}`);
  };

  // Raw k6 JSON of a worker (content of `--out json=`, one JSON line per data point)
  const downloadRaw = () => {
    const sid = sessionSelectValue;
    const wid = rawWorkerValue;
    if (!sid || !wid) return;
    triggerDownload(`${API_BASE}/api/raw-metrics?session=${encodeURIComponent(sid)}&worker=${encodeURIComponent(wid)}`);
  };

  /* ---------- API exposed to the components ---------- */

  return {
    // Top bar
    ledOn,
    workers,

    // Snapshots + drawing
    rowsRef,
    drawAll,
    canvasRefs,
    tipRef,
    logviewRef,

    // Series / metric
    workerIds,
    seriesVisible,
    setSeriesOn: (id, on) => {
      const m = new Map(seriesVisibleRef.current);
      m.set(id, on);
      seriesVisibleRef.current = m;
      setSeriesVisible(m);
    },
    metricName,
    setMetricName,
    metricNames,

    // Logs
    workerLogsRef,
    activeWorker,
    selectWorker: (id) => {
      activeWorkerRef.current = id;
      setActiveWorker(id);
    },
    totalLogLines,
    autoScroll,
    setAutoScroll,
    clearLogs,
    logRev,
    lastAppendedRef,
    clearedAtRef,
    onLogScroll: () => { stickRef.current = nearBottom(); },

    // Sessions & reports
    sessions,
    sessionSelectValue,
    rawWorkerValue,
    setRawWorkerValue,
    onSessionSelect: (id) => {
      setSessionSelectValue(id);
      userPinnedIdRef.current = id || null;
      if (id) socketRef.current && socketRef.current.emit('ui:show_session', { session: id });
    },
    latestSession,
    downloadReport,
    downloadRaw,

    // Form
    formStatus,
    submitting,
    submitTest,
    stopTest
  };
}
