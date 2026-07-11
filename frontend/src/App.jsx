import { useMemo, useState } from 'react';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import { divIcon } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './index.css';
import { mockCases } from './mockCases';

function App() {
  const [selectedCase, setSelectedCase] = useState(mockCases[0]);

  const markerIcons = useMemo(
    () =>
      Object.fromEntries(
        mockCases.map((item) => [
          item.id,
          divIcon({
            className: 'custom-div-icon',
            html: `<div style="background:${item.pin_color};"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          }),
        ]),
      ),
    [],
  );

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
          <div className="map-wrapper">
            <MapContainer
              center={[37.7749, -122.4194]}
              zoom={12}
              scrollWheelZoom
              className="leaflet-map"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />

              {mockCases.map((item) => (
                <Marker
                  key={item.id}
                  position={[item.latitude, item.longitude]}
                  icon={markerIcons[item.id]}
                  eventHandlers={{ click: () => setSelectedCase(item) }}
                >
                  <Popup>
                    <strong>{item.category}</strong>
                    <br />
                    {item.address}
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          </div>
          <div className="case-details">
            <h3>{selectedCase.category}</h3>
            <p>
              <strong>Description:</strong> {selectedCase.description}
            </p>
            <p>
              <strong>Address:</strong> {selectedCase.address}
            </p>
            <p>
              <strong>Status:</strong> {selectedCase.status}
            </p>
            <p>
              <strong>Priority Score:</strong> {selectedCase.priority_score}
            </p>
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
