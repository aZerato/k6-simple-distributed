import { CARDS } from '../lib/charts';

// Cartes de synthèse façon dashboard k6 (valeurs + sparklines canvas).
export default function Cards({ rows, canvasRefs }) {
  const lastRow = rows[rows.length - 1] || null;
  return (
    <div className="cards" id="cards">
      {CARDS.map((c) => {
        const v = lastRow ? c.get(lastRow) : null;
        return (
          <div className="card" key={c.label}>
            <span className="card-label">{c.label}</span>
            <span className={'card-value' + (c.neg && v != null && v > 0 ? ' neg' : '')}>
              {lastRow ? c.fmt(v) : '—'}
            </span>
            <canvas ref={(el) => { canvasRefs.current['card-' + c.label] = el; }} />
          </div>
        );
      })}
    </div>
  );
}
