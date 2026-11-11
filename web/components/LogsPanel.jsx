import { MAX_DOM_LINES } from '../lib/config';
import { fmtTs } from '../lib/format';

/*
 * Logs par worker (pas de concaténation : onglets par agent).
 * - mémoire : workerLogsRef (plafond MAX_LOG_KEEP par worker, côté hook)
 * - vue    : les MAX_DOM_LINES dernières lignes du worker actif, filtrées
             par l'horodatage « Vider »
 */
export default function LogsPanel({
  workerLogsRef,
  activeWorker,
  selectWorker,
  totalLogLines,
  autoScroll,
  setAutoScroll,
  clearLogs,
  logviewRef,
  onLogScroll,
  lastAppendedRef,
  clearedAtRef
}) {
  const arr = (activeWorker && workerLogsRef.current.get(activeWorker)) || [];
  const clearedAt = clearedAtRef.current;
  const view = arr
    .filter((l) => !clearedAt || Date.parse(l.t) > clearedAt)
    .slice(-MAX_DOM_LINES);

  return (
    <div className="panel logs-panel reveal">
      <div className="logs-head">
        <h2 className="panel-title inline">Logs par worker</h2>
        <span className="spacer" />
        <span className="log-count"><span>{totalLogLines.toLocaleString('fr-FR')}</span> lignes</span>
        <label className="switch">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          <span>Auto-scroll</span>
        </label>
        <button className="btn btn-ghost" id="btn-clear" type="button" onClick={clearLogs}>
          Vider
        </button>
      </div>
      <div className="logs-tabs">
        {[...workerLogsRef.current.entries()].map(([id, lines]) => (
          <button
            key={id}
            type="button"
            className={'logtab' + (id === activeWorker ? ' active' : '')}
            onClick={() => selectWorker(id)}
          >
            <span className="wname">{id}</span>
            <span className="tab-n">{lines.length}</span>
          </button>
        ))}
      </div>
      <div
        ref={logviewRef}
        className={'logview' + (arr.length === 0 ? ' is-empty' : '')}
        onScroll={onLogScroll}
      >
        <pre className="logpre">
          {view.map((l, i) => {
            const last = lastAppendedRef.current;
            const animate = !!activeWorker && last && activeWorker === last.workerId && l === last.line;
            return (
              <div key={i} className={'ln-log' + (l.type === 'stderr' ? ' err' : '') + (animate ? '' : ' fast')}>
                <span className="t">{fmtTs(l.t)}</span>
                <span className="x">[{l.type.toUpperCase()}] {l.text}</span>
              </div>
            );
          })}
        </pre>
        <div className="log-empty"><span>En attente d'un test…</span></div>
      </div>
    </div>
  );
}
