export default function WorkersPanel({ workers }) {
  return (
    <section className="panel reveal d1">
      <h2 className="panel-title">Workers</h2>
      <ul className="workers">
        {!workers.length && <li className="empty">Aucun worker connecté…</li>}
        {workers.map((w) => {
          const busy = w.status === 'BUSY';
          return (
            <li className="worker" key={w.id}>
              <span className="wname">{w.id}</span>
              <span className={'badge ' + (busy ? 'busy' : 'ok')}>
                <i className="dot" />
                {busy ? 'Occupé' : 'Disponible'}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
