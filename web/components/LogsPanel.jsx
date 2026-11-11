import { MAX_DOM_LINES } from '../lib/config';
import { fmtTs } from '../lib/format';

/*
 * Logs per worker (no concatenation: tabs per agent).
 * - memory: workerLogsRef (MAX_LOG_KEEP cap per worker, on the hook side)
 * - view  : the MAX_DOM_LINES latest lines of the active worker, filtered
             by the "Clear" timestamp
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
        <h2 className="panel-title inline">Logs per worker</h2>
        <span className="spacer" />
        <span className="log-count"><span>{totalLogLines.toLocaleString('en-US')}</span> lines</span>
        <label className="switch">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          <span>Auto-scroll</span>
        </label>
        <button className="btn btn-ghost" id="btn-clear" type="button" onClick={clearLogs}>
          Clear
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
        <div className="log-empty"><span>Waiting for a test…</span></div>
      </div>
    </div>
  );
}
