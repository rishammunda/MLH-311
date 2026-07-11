import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './worker.css';
import { fetchDemoState, acceptTask, CATEGORY_LABELS, PIN_COLORS } from './api.js';
import { CATEGORY_COLORS, glyphSvg, casePinSvg, crewBadgeSvg } from './icons.js';

const ME = new URLSearchParams(window.location.search).get('worker') || 'w1';

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

function renderIdentity(state) {
  const me = state.workers.find((worker) => worker.id === ME) || state.workers[0];
  if (!me) return;
  document.getElementById('me-avatar').textContent = me.avatar;
  document.getElementById('me-name').textContent = me.name;
  document.getElementById('me-role').textContent = `${me.role} · ${me.vehicle}`;
  document.title = `Field Ops · ${me.name}`;
}

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
          tiles: ['https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© CARTO · © OpenStreetMap'
        },
        route: {
          type: 'geojson',
          data: me ? {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[me.long, me.lat], [c.long, c.lat]] },
            properties: {}
          } : { type: 'FeatureCollection', features: [] }
        }
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#e9edf2' } },
        { id: 'carto', type: 'raster', source: 'carto', paint: { 'raster-opacity': 0.92, 'raster-saturation': -0.35, 'raster-brightness-max': 1 } },
        { id: 'route-halo', type: 'line', source: 'route', paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } },
        { id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#087ff5', 'line-width': 4, 'line-opacity': 0.96, 'line-dasharray': [1.2, 1.2] } }
      ]
    },
    center: [c.long, c.lat],
    zoom: 13,
    interactive: false,
    attributionControl: false
  });
  const pin = document.createElement('div');
  pin.className = 'mini-pin';
  pin.innerHTML = casePinSvg(c.ai_category in CATEGORY_COLORS ? c.ai_category : 'other');
  new maplibregl.Marker({ element: pin, anchor: 'bottom' }).setLngLat([c.long, c.lat]).addTo(miniMap);
  if (me) {
    const meEl = document.createElement('div');
    meEl.className = 'mini-me';
    meEl.innerHTML = crewBadgeSvg({ chosen: true });
    new maplibregl.Marker({ element: meEl, anchor: 'bottom' }).setLngLat([me.long, me.lat]).addTo(miniMap);
    // The card animates in; wait until the container has real dimensions
    // before fitting, or the zoom is computed against a 0-height box.
    setTimeout(() => {
      miniMap.resize();
      const b = new maplibregl.LngLatBounds();
      b.extend([c.long, c.lat]);
      b.extend([me.long, me.lat]);
      miniMap.fitBounds(b, { padding: { top: 70, bottom: 42, left: 48, right: 48 }, duration: 0, maxZoom: 14.4 });
    }, 120);
  }
}

function renderTask(state) {
  const c = state.case;
  const rec = state.recommendation;
  const category = c.ai_category in CATEGORY_COLORS ? c.ai_category : 'other';
  els.cat.style.setProperty('--issue', CATEGORY_COLORS[category]);
  els.cat.innerHTML = `${glyphSvg(category, { size: 12 })}<span>${CATEGORY_LABELS[c.ai_category] || c.ai_category}</span>`;
  els.urg.textContent = c.ai_urgency.toUpperCase();
  els.urg.style.setProperty('--urgc', c.ai_urgency === 'critical' || c.ai_urgency === 'high' ? PIN_COLORS.red : PIN_COLORS.yellow);
  els.score.textContent = `P·${c.priority_score}`;
  els.addr.textContent = c.address || 'San Francisco';
  els.hood.textContent = `${c.neighborhood || ''} · reported moments ago`;
  els.sum.textContent = c.ai_summary;
  els.dist.textContent = `${rec.distance_km} km`;
  els.eta.textContent = `${rec.eta_min} min`;
  els.why.innerHTML = rec.reasons.map((r) => `<div><span class="ph-task__tick">✓</span>${r}</div>`).join('');
  initMiniMap(state);
}

async function poll() {
  try {
    const state = await fetchDemoState();
    renderIdentity(state);
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
  fetchDemoState().then((state) => {
    if (!state.case) return;
    window.open(`https://maps.apple.com/?daddr=${state.case.lat},${state.case.long}`, '_blank', 'noopener');
  });
});

poll();
setInterval(poll, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
