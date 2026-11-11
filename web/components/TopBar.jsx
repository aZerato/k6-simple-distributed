export default function TopBar({ ledOn, workersCount }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">k6</span>
        <span className="brand-text">
          <span className="brand-title">Orchestrateur</span>
          <span className="brand-sub">Console de charge distribuée</span>
        </span>
      </div>
      <div className="topbar-right">
        <div className="stat">
          <span className="stat-label">WORKERS</span>
          <span className="stat-value">{workersCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">LIEN</span>
          <span className={'led' + (ledOn ? ' on' : '')} title="Connexion socket.io à l'orchestrateur" />
        </div>
      </div>
    </header>
  );
}
