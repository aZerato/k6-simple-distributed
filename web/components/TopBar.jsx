export default function TopBar({ ledOn, workersCount }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">k6</span>
        <span className="brand-text">
          <span className="brand-title">Orchestrator</span>
          <span className="brand-sub">Distributed load console</span>
        </span>
      </div>
      <div className="topbar-right">
        <div className="stat">
          <span className="stat-label">WORKERS</span>
          <span className="stat-value">{workersCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">LIEN</span>
          <span className={'led' + (ledOn ? ' on' : '')} title="socket.io connection to the orchestrator" />
        </div>
      </div>
    </header>
  );
}
