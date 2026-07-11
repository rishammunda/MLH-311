import './index.css';

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>InfraPriority</h1>
      </header>

      <main className="dashboard-layout">
        <section className="map-panel" aria-label="Map panel">
          <div className="panel-heading">
            <h2>Map</h2>
          </div>
          <div className="placeholder-map">
            <p>Map placeholder</p>
          </div>
        </section>

        <aside className="queue-panel" aria-label="Priority queue panel">
          <div className="panel-heading">
            <h2>Priority Queue</h2>
          </div>
          <div className="queue-list">
            <div className="queue-item">Pending inspection</div>
            <div className="queue-item">Resource review</div>
            <div className="queue-item">Escalation backlog</div>
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
