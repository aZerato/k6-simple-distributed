import { CHART_DEFS, buildSeries, isSeriesOn } from '../lib/charts';

/*
 * Les 4 graphiques principaux (HTTP req/s, Données, VUS, Checks).
 * Chaque panneau : canvas + cases à cocher (Fusion + courbe par worker).
 * Le dessin lui-même est déclenché par la page (dash.drawAll).
 */

const PANEL_TITLES = {
  http: { title: 'HTTP req/s', legend: <><i className="sw sw-accent" />req/s <i className="sw sw-red" />failed/s</> },
  data: { title: 'Données (B/s)', legend: <><i className="sw sw-blue" />reçues <i className="sw sw-amber" />envoyées</> },
  vus: { title: 'VUS', legend: <><i className="sw sw-accent" />actifs</> },
  checks: { title: 'Checks passés', legend: <><i className="sw sw-accent" />%</> }
};

function SeriesToggles({ def, workerIds, seriesVisible, onToggle }) {
  return (
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
