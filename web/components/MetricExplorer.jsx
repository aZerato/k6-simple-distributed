import { fmtInt, fmtNum } from '../lib/format';
import { buildSeries, isSeriesOn, metricDef } from '../lib/charts';

/*
 * Explorateur de métrique : sélection + graphique (avg + p95, et par worker)
 * + tableau des percentiles (ligne fusion + une par worker).
 */

const COLS = ['count', 'rate', 'avg', 'p70', 'p80', 'p90', 'p95', 'p99', 'min', 'max'];
const FMTS = [fmtInt, fmtInt, fmtNum, fmtNum, fmtNum, fmtNum, fmtNum, fmtNum, fmtNum, fmtNum];

function MetricTable({ rows, workerIds, metricName }) {
  const lastRow = rows[rows.length - 1] || null;
  const st = metricName && lastRow ? lastRow.metrics[metricName] : null;

  const row = (src, s, extra) => (
    <tr className={extra} key={src}>
      <td className="src">{src}</td>
      {COLS.map((k, i) => (
        <td key={k}>{FMTS[i](s[k])}</td>
      ))}
    </tr>
  );

  let body;
  let note;
  if (!st) {
    body = row('fusion', { count: null, rate: null, avg: null, p70: null, p80: null, p90: null, p95: null, p99: null, min: null, max: null });
    note = 'Pas encore de points pour cette métrique.';
  } else {
    // Ligne de fusion + une ligne par worker
    const workerRows = workerIds
      .map((wid) => {
        const wst = (lastRow.byWorker || {})[wid] && (lastRow.byWorker[wid][metricName]);
        return wst ? row(wid, wst) : null;
      })
      .filter(Boolean);
    body = [row('fusion', st, 'fusion-row'), ...workerRows];
    note = `Métrique « ${metricName} » — percentiles recalculés sur les ${Math.min(rows.length, 5000)} derniers points.`;
  }

  return (
    <div className="metric-table">
      <table>
        <thead>
          <tr>
            <th className="src-th">source</th>
            {COLS.map((k) => (
              <th key={k}>{k}</th>
            ))}
          </tr>
        </thead>
        <tbody id="metric-tbody">{body}</tbody>
      </table>
      <p className="metric-note">{note}</p>
    </div>
  );
}

export default function MetricExplorer({ rows, workerIds, seriesVisible, metricName, metricNames, onMetricChange, canvasRefs, onToggle }) {
  const def = metricName ? metricDef(metricName) : null;

  return (
    <div className="panel metric-panel reveal">
      <div className="metric-head">
        <h2 className="panel-title inline">Métrique</h2>
        <select id="metric-select" className="select" aria-label="Métrique" value={metricName} onChange={(e) => onMetricChange(e.target.value)}>
          {metricNames.length === 0 ? (
            <option value="">(en attente de données)</option>
          ) : (
            metricNames.map((n) => (
              <option value={n} key={n}>{n}</option>
            ))
          )}
        </select>
        <span className="legend"><i className="sw sw-accent" />avg <i className="sw sw-amber" />p95</span>
      </div>
      <div className="metric-body">
        <div className="metric-chart-wrap">
          <canvas ref={(el) => { canvasRefs.current['metric'] = el; }} />
          {def && (
            <div className="series-toggle" aria-label="Séries affichées">
              {buildSeries(def, workerIds).map((s) => (
                <label className="sr" key={s.id}>
                  <input
                    type="checkbox"
                    checked={isSeriesOn(seriesVisible, s.id)}
                    onChange={(e) => onToggle(s.id, e.target.checked)}
                  />
                  <i className="sw2" style={{ background: s.color }} />
                  {s.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <MetricTable rows={rows} workerIds={workerIds} metricName={metricName} />
      </div>
    </div>
  );
}
