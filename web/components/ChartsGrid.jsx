import { CHART_DEFS, buildSeries, isSeriesOn } from '../lib/charts';

/*
 * The 4 main charts (HTTP req/s, Data, VUS, Checks).
 * Each panel: canvas + checkboxes (merged + one curve per worker).
 * The drawing itself is triggered by the page (dash.drawAll).
 */

const PANEL_TITLES = {
  http: { title: 'HTTP req/s', legend: <><i className="sw sw-accent" />req/s <i className="sw sw-red" />failed/s</> },
  data: { title: 'Data (B/s)', legend: <><i className="sw sw-blue" />received <i className="sw sw-amber" />sent</> },
  vus: { title: 'VUS', legend: <><i className="sw sw-accent" />active</> },
  checks: { title: 'Checks passed', legend: <><i className="sw sw-accent" />%</> }
};

function SeriesToggles({ def, workerIds, seriesVisible, onToggle }) {
  return (
    <div className="series-toggle" aria-label="Visible series">
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
  );
}

export default function ChartsGrid({ workerIds, seriesVisible, onToggle, canvasRefs }) {
  return (
    <div className="charts-grid">
      {CHART_DEFS.map((c) => {
        const head = PANEL_TITLES[c.key];
        return (
          <div className="panel chart-panel reveal" key={c.key}>
            <div className="chart-head">
              <h2 className="panel-title inline">{head.title}</h2>
              <span className="legend">{head.legend}</span>
            </div>
            <canvas ref={(el) => { canvasRefs.current[c.key] = el; }} />
            <SeriesToggles def={c} workerIds={workerIds} seriesVisible={seriesVisible} onToggle={onToggle} />
          </div>
        );
      })}
    </div>
  );
}
