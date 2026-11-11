import { useEffect } from 'react';

/*
 * "Report" strip: session to export, raw JSON per worker,
 * .html / .json / .txt / .jsonl downloads.
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

  // On every update of the session list (or of the selection),
  // the raw JSON selector resets to the first worker of the session
  // (behavior of the legacy console).
  useEffect(() => {
    setRawWorkerValue(rawIds[0] || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionSelectValue, sessions]);

  const reportMeta = latestSession
    ? `${latestSession.overall} · ${latestSession.totalVus} VUs · ${latestSession.workers.length} worker(s) · ${latestSession.duration}`
    : 'No session';

  return (
    <div className="report-strip panel reveal">
      <span className="panel-title inline">Report</span>
      <select
        id="session-select"
        className="select"
        aria-label="Session to export"
        value={sessionSelectValue}
        onChange={(e) => onSessionSelect(e.target.value)}
      >
        {!sessions.length && <option value="">No session</option>}
        {sessions.map((s) => (
          <option value={s.id} key={s.id}>
            {`${s.id} — ${s.overall} · ${s.totalVus} VUs · ${s.workerCount}w · ${new Date(s.createdAt).toLocaleString('en-US')}`}
          </option>
        ))}
      </select>
      <select
        id="raw-worker-select"
        className="select"
        aria-label="Worker of the raw JSON"
        disabled={!has}
        value={rawWorkerValue}
        onChange={(e) => setRawWorkerValue(e.target.value)}
      >
        {rawIds.length === 0 ? (
          <option value="">(no worker targeted)</option>
        ) : (
          rawIds.map((w) => (
            <option value={w} key={w}>{w}</option>
          ))
        )}
      </select>
      <span className="report-meta" id="report-meta">{reportMeta}</span>
      <button className="btn btn-primary" id="btn-report-html" disabled={!has} onClick={() => downloadReport('html')}>
        ⬇ Report (.html)
      </button>
      <button className="btn btn-ghost" id="btn-report-json" disabled={!has} onClick={() => downloadReport('json')}>
        ⬇ Report (.json)
      </button>
      <button className="btn btn-ghost" id="btn-report-txt" disabled={!has} onClick={() => downloadReport('txt')}>
        Summary (.txt)
      </button>
      <button
        className="btn btn-ghost"
        id="btn-report-raw"
        disabled={!has || !rawWorkerValue}
        title="Raw k6 JSON output (--out json= file, one line per data point)"
        onClick={downloadRaw}
      >
        ⬇ Raw k6 JSON (.jsonl)
      </button>
    </div>
  );
}
