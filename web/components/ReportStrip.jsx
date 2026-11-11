import { useEffect } from 'react';

/*
 * Bandeau « Rapport » : session à exporter, JSON brut par worker,
 * téléchargements .html / .json / .txt / .jsonl.
 */
export default function ReportStrip({
  sessions,
  sessionSelectValue,
  onSessionSelect,
  rawWorkerValue,
  setRawWorkerValue,
  latestSession,
  downloadReport,
  downloadRaw
}) {
  const selected = sessions.find((s) => s.id === sessionSelectValue) || null;
  const rawIds = (selected && selected.workerIds) || [];
  const has = !!sessionSelectValue;

  // À chaque mise à jour de la liste des sessions (ou de la sélection),
  // le sélecteur du JSON brut repart sur le 1er worker de la session
  // (comportement de la console legacy).
  useEffect(() => {
    setRawWorkerValue(rawIds[0] || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionSelectValue, sessions]);

  const reportMeta = latestSession
    ? `${latestSession.overall} · ${latestSession.totalVus} VUs · ${latestSession.workers.length} worker(s) · ${latestSession.duration}`
    : 'Aucune session';

  return (
    <div className="report-strip panel reveal">
      <span className="panel-title inline">Rapport</span>
      <select
        id="session-select"
        className="select"
        aria-label="Session à exporter"
        value={sessionSelectValue}
        onChange={(e) => onSessionSelect(e.target.value)}
      >
        {!sessions.length && <option value="">Aucune session</option>}
        {sessions.map((s) => (
          <option value={s.id} key={s.id}>
            {`${s.id} — ${s.overall} · ${s.totalVus} VUs · ${s.workerCount}w · ${new Date(s.createdAt).toLocaleString('fr-FR')}`}
          </option>
        ))}
      </select>
      <select
        id="raw-worker-select"
        className="select"
        aria-label="Worker du JSON brut"
        disabled={!has}
        value={rawWorkerValue}
        onChange={(e) => setRawWorkerValue(e.target.value)}
      >
        {rawIds.length === 0 ? (
          <option value="">(aucun worker ciblé)</option>
        ) : (
          rawIds.map((w) => (
            <option value={w} key={w}>{w}</option>
          ))
        )}
      </select>
      <span className="report-meta" id="report-meta">{reportMeta}</span>
      <button className="btn btn-primary" id="btn-report-html" disabled={!has} onClick={() => downloadReport('html')}>
        ⬇ Rapport (.html)
      </button>
      <button className="btn btn-ghost" id="btn-report-json" disabled={!has} onClick={() => downloadReport('json')}>
        ⬇ Rapport (.json)
      </button>
      <button className="btn btn-ghost" id="btn-report-txt" disabled={!has} onClick={() => downloadReport('txt')}>
        Résumé (.txt)
      </button>
      <button
        className="btn btn-ghost"
        id="btn-report-raw"
        disabled={!has || !rawWorkerValue}
        title="Sortie JSON brute de k6 (fichier --out json=, une ligne par point de données)"
        onClick={downloadRaw}
      >
        ⬇ JSON brut k6 (.jsonl)
      </button>
    </div>
  );
}
