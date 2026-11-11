import { CHART_DEFS, buildSeries, isSeriesOn } from '../lib/charts';

/*
 * The 4 main charts (HTTP req/s, Data, VUS, Checks).
 * Each panel: canvas + checkboxes (merged + one curve per worker).
 * The global "curve mode" (merged / per worker / all) applies to every chart.
 * The drawing itself is triggered by the page (dash.drawAll).
 */

const PANEL_TITLES = {
  http: { title: 'HTTP req/s', legend: <><i className="sw sw-accent" />req/s <i className="sw sw-red" />failed/s</> },
  data: { title: 'Data (B/s)', legend: <><i className="sw sw-blue" />received <i className="sw sw-amber" />sent</> },
  vus: { title: 'VUS', legend: <><i className="sw sw-accent" />active</> },
  checks: { title: 'Checks passed', legend: <><i className="sw sw-accent" />%</> }
};

// Global curve presets: which curves are shown by default on every chart.
const MODES = [
  { id: 'fusion', label: 'Merged' },
  { id: 'workers', label: 'Per worker' },
  { id: 'all', label: 'All' }
];

function CurveModeBar({ curveMode, onModeChange }) {
  return (
    <div className="charts-toolbar">
      <span className="charts-toolbar-label">Curves</span>
      <div className="mode-seg" role="group" aria-label="Curve visibility">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={'mode-btn' + (curveMode === m.id ? ' on' : '')}
            onClick={() => onModeChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SeriesToggles({ def, workerIds, curveMode, seriesVisible, onToggle }) {
  return (
    <div className="series-toggle" aria-label="Visible series">
      {buildSeries(def, workerIds).map((s) => (
        <label className="sr" key={s.id}>
          <input
            type="checkbox"
            checked={isSeriesOn(curveMode, seriesVisible, s)}
            onChange={(e) => onToggle(s.id, e.target.checked)}
          />
          <i className="sw2" style={{ background: s.color }} />
          {s.label}
        </label>
      ))}
    </div>
  );
}

export default function ChartsGrid({ workerIds, seriesVisible, onToggle, curveMode, onModeChange, canvasRefs }) {
  return (
    <>
      <CurveModeBar curveMode={curveMode} onModeChange={onModeChange} />
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
              <SeriesToggles def={c} workerIds={workerIds} curveMode={curveMode} seriesVisible={seriesVisible} onToggle={onToggle} />
            </div>
          );
        })}
      </div>
    </>
  );
}
