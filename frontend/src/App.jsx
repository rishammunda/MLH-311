import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { divIcon } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './index.css';
import { mockCases } from './mockCases';

function MapController({ selectedCaseId, markerRefs }) {
  const map = useMap();

  useEffect(() => {
    if (!selectedCaseId) {
      return;
    }

    const selectedCase = mockCases.find((item) => item.id === selectedCaseId);
    const marker = markerRefs.current[selectedCaseId];

    if (!selectedCase || !marker) {
      return;
    }

    map.flyTo([selectedCase.latitude, selectedCase.longitude], 15, {
      animate: true,
      duration: 0.8,
    });

    const handleMoveEnd = () => {
      marker.openPopup();
    };

    map.once('moveend', handleMoveEnd);

    return () => {
      map.off('moveend', handleMoveEnd);
    };
  }, [map, markerRefs, selectedCaseId]);

  return null;
}

function App() {
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const rankedCases = useMemo(
    () => [...mockCases].sort((a, b) => b.priority_score - a.priority_score),
    [],
  );
  const markerRefs = useRef({});

  const handleSelectCase = (caseId) => {
    setSelectedCaseId(caseId);
  };

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
              <MapController selectedCaseId={selectedCaseId} markerRefs={markerRefs} />
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />

              {mockCases.map((item) => (
                <Marker
                  key={item.id}
                  position={[item.latitude, item.longitude]}
                  icon={markerIcons[item.id]}
                  ref={(instance) => {
                    markerRefs.current[item.id] = instance;
                  }}
                  eventHandlers={{ click: () => handleSelectCase(item.id) }}
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
        </section>

        <aside className="queue-panel" aria-label="Priority queue panel">
          <div className="panel-heading">
            <h2>Priority Queue</h2>
          </div>
          <div className="queue-list" role="list">
            {rankedCases.map((item, index) => {
              const isSelected = selectedCaseId === item.id;

              return (
                <button
                  key={item.id}
                  type="button"
                  className={`queue-item ${isSelected ? 'queue-item-selected' : ''}`}
                  onClick={() => handleSelectCase(item.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleSelectCase(item.id);
                    }
                  }}
                  aria-pressed={isSelected}
                >
                  <span className="queue-rank">#{index + 1}</span>
                  <span className="queue-content">
                    <strong>{item.category}</strong>
                    <span>{item.address}</span>
                    <span>Score: {item.priority_score}</span>
                  </span>
                  <span className="queue-indicator" style={{ backgroundColor: item.pin_color }} />
                </button>
              );
            })}
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
