import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './worker.css';
import { fetchDemoState, acceptTask, CATEGORY_LABELS, PIN_COLORS } from './api.js';

const ME = 'w1'; // Marcus Rivera — the crew the demo recommends

const els = {
  idle: document.getElementById('ph-idle'),
  task: document.getElementById('ph-task'),
  ok: document.getElementById('ph-ok'),
  status: document.getElementById('me-status'),
  net: document.getElementById('net-dot'),
  cat: document.getElementById('task-cat'),
  urg: document.getElementById('task-urg'),
  score: document.getElementById('task-score'),
  addr: document.getElementById('task-addr'),
  hood: document.getElementById('task-hood'),
  sum: document.getElementById('task-sum'),
  dist: document.getElementById('task-dist'),
  eta: document.getElementById('task-eta'),
  why: document.getElementById('task-why'),
  okSub: document.getElementById('ok-sub')
};

let view = 'idle'; // idle | task | accepted
let declined = false;
let miniMap = null;

function show(next) {
  if (view === next) return;
  view = next;
  els.idle.classList.toggle('ph-idle--hidden', next !== 'idle');
  els.task.classList.toggle('ph-task--hidden', next !== 'task');
  els.ok.classList.toggle('ph-ok--hidden', next !== 'accepted');
  els.status.textContent = next === 'accepted' ? 'EN ROUTE' : 'ON SHIFT';
  els.status.classList.toggle('ph-me__status--route', next === 'accepted');
  if (next === 'task' && navigator.vibrate) navigator.vibrate([120, 60, 120]);
}

function initMiniMap(state) {
  if (miniMap) return;
  const c = state.case;
  const me = state.workers.find((w) => w.id === ME);
  miniMap = new maplibregl.Map({
    container: 'task-map',
    style: {
      version: 8,
      sources: {
        carto: {
          type: 'raster',
          tiles: ['https://a.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© CARTO · © OpenStreetMap'
        }
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0a1120' } },
        { id: 'carto', type: 'raster', source: 'carto', paint: { 'raster-opacity': 1, 'raster-brightness-max': 0.95, 'raster-contrast': 0.08 } }
      ]
    },
    center: [c.long, c.lat],
    zoom: 13,
    interactive: false,
    attributionControl: false
  });
  const pin = document.createElement('div');
  pin.className = 'mini-pin';
  new maplibregl.Marker({ element: pin }).setLngLat([c.long, c.lat]).addTo(miniMap);
  if (me) {
    const meEl = document.createElement('div');
    meEl.className = 'mini-me';
    meEl.textContent = 'MR';
    new maplibregl.Marker({ element: meEl }).setLngLat([me.long, me.lat]).addTo(miniMap);
    // The card animates in; wait until the container has real dimensions
    // before fitting, or the zoom is computed against a 0-height box.
    setTimeout(() => {
      miniMap.resize();
      const b = new maplibregl.LngLatBounds();
      b.extend([c.long, c.lat]);
      b.extend([me.long, me.lat]);
      miniMap.fitBounds(b, { padding: { top: 34, bottom: 46, left: 60, right: 60 }, duration: 0 });
    }, 120);
  }
}

function renderTask(state) {
  const c = state.case;
  const rec = state.recommendation;
  els.cat.textContent = (CATEGORY_LABELS[c.ai_category] || c.ai_category).toUpperCase();
  els.urg.textContent = c.ai_urgency.toUpperCase();
  els.urg.style.setProperty('--urgc', c.ai_urgency === 'critical' || c.ai_urgency === 'high' ? PIN_COLORS.red : PIN_COLORS.yellow);
  els.score.textContent = `P·${c.priority_score}`;
  els.addr.textContent = c.address || 'San Francisco';
  els.hood.textContent = `${c.neighborhood || ''} · reported moments ago`;
  els.sum.textContent = c.ai_summary;
  els.dist.textContent = `${rec.distance_km} km`;
  els.eta.textContent = `${rec.eta_min} min`;
  els.why.innerHTML = rec.reasons.map((r) => `<div>• ${r}</div>`).join('');
  initMiniMap(state);
}

async function poll() {
  try {
    const state = await fetchDemoState();
    els.net.classList.remove('ph-app__net--down');
    const rec = state.recommendation;
    const mine = rec && rec.worker_id === ME;

    if (!mine) {
      declined = false;
      if (miniMap) { miniMap.remove(); miniMap = null; }
      show('idle');
      return;
    }
    if (rec.status === 'accepted') {
      els.okSub.textContent = `${state.case.address} · ETA ${rec.eta_min} min`;
      show('accepted');
      return;
    }
    if (!declined) {
      show('task');
      renderTask(state);
    }
  } catch {
    els.net.classList.add('ph-app__net--down');
  }
}

document.getElementById('btn-accept').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    await acceptTask();
    await poll();
  } finally {
    e.target.disabled = false;
  }
});
document.getElementById('btn-decline').addEventListener('click', () => {
  declined = true;
  show('idle');
});
document.getElementById('btn-nav').addEventListener('click', () => {
  document.getElementById('btn-nav').textContent = 'Navigation started (demo)';
});

poll();
setInterval(poll, 1000);
