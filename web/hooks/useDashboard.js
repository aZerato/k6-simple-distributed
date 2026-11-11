'use client';
/* ============================================================
   useDashboard — le « cerveau » de la console
   (port React de public/app.js : socket + état de la vue)

   - connexion socket.io à l'orchestrateur (événements ui:*)
   - état de la vue : session affichée / session « piquetée » / session RUNNING
   - rows (snapshots ui:metrics), séries par worker, logs par worker
   - garde-fou « refresh forcé » (watchdog 1/s)
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
  /* ---------- refs (état mutable, closures stables) ---------- */

  const socketRef = useRef(null);
  const rowsRef = useRef([]); // snapshots (ui:metrics) de la session affichée
  const workerIdsRef = useRef([]); // workers ayant produit des métriques (ordre d'apparition)
  const seriesVisibleRef = useRef(new Map()); // id de série -> visible
  const maxSeqRef = useRef(0); // dédoublonnage du rejeu
  const workerLogsRef = useRef(new Map()); // workerId -> [ { t, type, text } ]
  const activeWorkerRef = useRef(null); // onglet de logs sélectionné
  const lastAppendedRef = useRef(null); // dernière ligne ajoutée (animation)
  const clearedAtRef = useRef(0); // bouton « Vider » (epoch ms)
  const activeSessionIdRef = useRef(null); // session affichée (graphiques + logs)
  const userPinnedIdRef = useRef(null); // session choisie dans le sélecteur « Rapport »
  const runningSessionIdRef = useRef(null); // session RUNNING (d'après ui:session_state)
  const lastRowAtRef = useRef(0); // horodatage du dernier snapshot reçu
  const lastResyncAtRef = useRef(0); // dernier rejeu forcé (garde-fou anti-boucle)
  const stickRef = useRef(true); // « collé » au bas des logs ?
  const hoverRef = useRef(null); // { redraw, index } — graphique actuellement survolé
  const logviewRef = useRef(null);
  const tipRef = useRef(null);
  const canvasRefs = useRef({}); // clé -> élément canvas

  /* ---------- état React (rendu) ---------- */

  const [ledOn, setLedOn] = useState(false);
  const [workers, setWorkers] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [latestSession, setLatestSession] = useState(null);
  const [rowsRev, setRowsRev] = useState(0); // tick : les rows ont changé
  const [workerIds, setWorkerIds] = useState([]);
  const [metricNames, setMetricNames] = useState([]);
  const [metricName, setMetricName] = useState('');
  const [seriesVisible, setSeriesVisible] = useState(new Map());
  const [sessionSelectValue, setSessionSelectValue] = useState('');
  const [rawWorkerValue, setRawWorkerValue] = useState('');
  const [activeWorker, setActiveWorker] = useState(null);
  const [logRev, setLogRev] = useState(0); // tick : les logs ont changé
  const [totalLogLines, setTotalLogLines] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [formStatus, setFormStatus] = useState({ cls: '', text: '' });
  const [submitting, setSubmitting] = useState(false);

  const metricNameRef = useRef('');
  useEffect(() => { metricNameRef.current = metricName; }, [metricName]);
  useEffect(() => { seriesVisibleRef.current = seriesVisible; }, [seriesVisible]);

  /* ---------- helpers de logs ---------- */

  const nearBottom = () => {
    const el = logviewRef.current;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const scrollBottom = () => {
    const el = logviewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  /* ---------- Réinitialisation complète de la vue (bascule de session) ---------- */

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

  /* ---------- Métriques : workers apparus + métriques connues ---------- */

  // Un worker émet-t-il des métriques pour la première fois ? (mise à jour des séries)
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

  // Port de syncMetricSelect : conserve la sélection si encore valide, sinon la 1re.
  const syncMetricNames = () => {
    const names = knownMetrics(rowsRef.current);
    setMetricNames(names);
    setMetricName((cur) => (names.includes(cur) ? cur : names[0] || ''));
  };

  /* ---------- Sessions & rapports (port de fillSelect / refreshSessions) ---------- */

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
      .catch(() => { /* orchestrateur momentanément injoignable */ });
    if (forceId) setSessionSelectValue(forceId);
  };

  /* ---------- État de session (port de applySessionState + setLatest) ---------- */

  const applySessionState = (s) => {
    if (!s) return;
    const hijack = s.status === 'RUNNING' && s.id !== activeSessionIdRef.current;
    if (s.status === 'RUNNING') runningSessionIdRef.current = s.id;
    else if (s.id === runningSessionIdRef.current) runningSessionIdRef.current = null;
    if (hijack) {
      // Un nouveau test repart : la vue repasse dessus (même si l'utilisateur
      // regardait une autre session).
      userPinnedIdRef.current = null;
      activeSessionIdRef.current = s.id;
      resetAll();
    }
    setLatestSession(s);
    refreshSessions(hijack ? s.id : undefined);
  };

  /* ---------- Logs : ajout d'une ligne ---------- */

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

    // Première ligne d'un worker non encore suivi : on l'active automatiquement
    if (!activeWorkerRef.current) {
      activeWorkerRef.current = workerId;
      setActiveWorker(workerId);
    }
    setLogRev((r) => r + 1);
  };

  /* ---------- Socket temps réel ---------- */

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

    // Rejeu des logs déjà produits (connexion en retard, ou session sélectionnée dans le bandeau « Rapport »)
    socket.on('ui:logs_replay', ({ session, workers }) => {
      if (session !== activeSessionIdRef.current) {
        // Bascule de la vue vers la session demandée
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
      if (l.seq && l.seq <= maxSeqRef.current) return; // déjà rejouée
      if (l.seq) maxSeqRef.current = l.seq;
      appendLogLine(l);
    });

    // Snapshots de métriques (rejeu à la demande puis 1/s pendant le test)
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
        // Le snapshot ne correspond pas à la session affichée :
        //  - si l'utilisateur a choisi une session dans le sélecteur « Rapport »,
        //    on reste dessus (pas de rattrapage automatique) ;
        //  - sinon c'est le flux live du test en cours : on (re)bascule dessus,
        //    même si l'état de démarrage a été manqué (reconnexion, etc.).
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

  /* ---------- Garde-fou « refresh forcé » (1/s) ----------
     Pendant un test en cours, si le flux live ne parvient plus à la vue
     (reconnexion ratée, état manqué, onglet endormi…), on redemande à
     l'orchestrateur l'historique de la session en cours : les graphiques,
     cartes et tableau redeviennent à jour automatiquement. */
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

  /* ---------- Init : historique des sessions ---------- */
  useEffect(() => {
    refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Dessin (port de drawCharts + updateCards) ---------- */

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
    // Le curseur survole-t-il un graphique ? On garde le repère stable pendant les rafraîchissements live
    if (hoverRef.current) hoverRef.current.redraw(hoverRef.current.index);

    // Cartes de synthèse : sparklines
    const vals = rows.slice(-SPARK_LEN);
    for (const c of CARDS) {
      const el = canvases['card-' + c.label];
      if (!el) continue;
      drawSpark(el, vals.map((row) => (c.spark(row) == null ? 0 : c.spark(row))), c.color);
    }
  }, []);

  /* ---------- Survol des graphiques (valeur à l'instant t) ---------- */

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
        // Valeur de TOUTES les séries affichées à l'instant t (fusion + workers)
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

  /* ---------- Contrôles : formulaire, arrêt, vider, downloads ---------- */

  const submitTest = async ({ scriptPath, scriptContent, totalVus, duration }) => {
    setSubmitting(true);
    setFormStatus({ cls: '', text: 'Envoi…' });
    // Le script est soit collé, soit pointé par un fichier .js (lu par l'orchestrateur)
    if (!scriptPath && !scriptContent) {
      setFormStatus({ cls: 'err', text: 'Aucun script : collez du code k6 ou indiquez un fichier .js.' });
      setSubmitting(false);
      return;
    }
    const payload = { totalVus, duration };
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
      // La vue bascule immédiatement sur la nouvelle session, sans attendre l'état socket
      userPinnedIdRef.current = null;
      activeSessionIdRef.current = data.sessionId;
      resetAll();
      // Refresh forcé : l'orchestrateur rejoue l'historique de la session → les
      // graphiques, cartes et tableau sont garantis à jour dès la relance.
      socketRef.current && socketRef.current.emit('ui:show_session', { session: data.sessionId });
      refreshSessions(data.sessionId);
      setFormStatus({
        cls: 'ok',
        text: `${scriptPath ? `Fichier : ${scriptPath} — ` : ''}Test lancé — ${data.workersCibles} worker(s) ciblé(s), session ${data.sessionId}.`
      });
    } catch (err) {
      setFormStatus({ cls: 'err', text: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const stopTest = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/test/stop`, { method: 'POST' });
      const data = await res.json();
      setFormStatus({ cls: 'ok', text: data.message });
    } catch {
      setFormStatus({ cls: 'err', text: "Impossible d'envoyer l'ordre d'arrêt." });
    }
  };

  const clearLogs = () => {
    // « Vider » : purge la vue seulement (la mémoire par worker est conservée,
    // comme dans la console legacy).
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

  // JSON brut k6 d'un worker (contenu du `--out json=`, une ligne JSON par point)
  const downloadRaw = () => {
    const sid = sessionSelectValue;
    const wid = rawWorkerValue;
    if (!sid || !wid) return;
    triggerDownload(`${API_BASE}/api/raw-metrics?session=${encodeURIComponent(sid)}&worker=${encodeURIComponent(wid)}`);
  };

  /* ---------- API exposée aux composants ---------- */

  return {
    // Barre du haut
    ledOn,
    workers,

    // Snapshots + dessin
    rowsRef,
    drawAll,
    canvasRefs,
    tipRef,
    logviewRef,

    // Séries / métrique
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

    // Sessions & rapports
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

    // Formulaire
    formStatus,
    submitting,
    submitTest,
    stopTest
  };
}
