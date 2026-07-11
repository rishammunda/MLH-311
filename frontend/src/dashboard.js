import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import {
  fetchCases, fetchDemoState, startCall, resetDemo,
  CATEGORY_LABELS, PIN_COLORS, GOOD, ACCENT, timeAgo
} from './api.js';

// ---------------------------------------------------------------------------
// Map bootstrap — 3D skyline foundation adapted from "The Skyline Project"
// (github.com/perlakay/nyc-building-history, MIT © Perla Dahan).
// ---------------------------------------------------------------------------

const CENTER = [-122.4235, 37.772];
const HOME = { center: CENTER, zoom: 12.9, pitch: 57, bearing: 24 };

const STYLE = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    'carto-dark': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png'
      ],
      tileSize: 256,
      attribution:
        'Skyline © <a href="https://github.com/perlakay/nyc-building-history">Perla Dahan (MIT)</a> · © <a href="https://carto.com/">CARTO</a> · © <a href="https://openstreetmap.org">OpenStreetMap</a> · Buildings © <a href="https://data.sfgov.org/">DataSF</a>'
    },
    'carto-labels': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}.png'
      ],
      tileSize: 256
    }
  },
  light: { anchor: 'viewport', color: '#bcd2ff', intensity: 0.45, position: [1.3, 210, 40] },
  sky: {
    'sky-color': '#04070d',
    'horizon-color': '#0d1830',
    'fog-color': '#060a14',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.7,
    'fog-ground-blend': 0.75
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#05080f' } },
    { id: 'carto-dark', type: 'raster', source: 'carto-dark', paint: { 'raster-opacity': 0.85, 'raster-saturation': -0.25 } },
    { id: 'carto-labels', type: 'raster', source: 'carto-labels', paint: { 'raster-opacity': 0.5 } }
  ]
};

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE,
  ...HOME,
  maxBounds: [[-122.56, 37.66], [-122.31, 37.86]],
  minZoom: 10.8,
  maxZoom: 18,
  antialias: true
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false }), 'bottom-right');

const boot = {
  el: document.getElementById('boot'),
  fill: document.getElementById('boot-fill'),
  hint: document.getElementById('boot-hint'),
  set(msg, pct) {
    this.hint.textContent = msg;
    if (typeof pct === 'number') this.fill.style.width = `${pct}%`;
  },
  done() {
    this.set('ready', 100);
    this.el.classList.add('boot--hidden');
    setTimeout(() => this.el.remove(), 900);
  }
};

async function loadBuildings() {
  boot.set('downloading city model…', 6);
  const res = await fetch('/data/sf/buildings.geojson');
  if (!res.ok) throw new Error('buildings fetch failed');
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) boot.set(`city model · ${(received / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`, 6 + (received / total) * 54);
  }
  boot.set('shaping 145,000 buildings…', 66);
  await new Promise((r) => setTimeout(r, 30));
  return JSON.parse(await new Blob(chunks).text());
}

// ---------------------------------------------------------------------------
// Case + worker layers
// ---------------------------------------------------------------------------

const EMPTY_FC = { type: 'FeatureCollection', features: [] };
let allCases = [];
let workerMarkers = new Map(); // id -> { marker, el, worker }
let demoCaseId = null;

function casesToFC(cases) {
  return {
    type: 'FeatureCollection',
    features: cases.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.long, c.lat] },
      properties: {
        id: c.id,
        color: PIN_COLORS[c.pin_color] || PIN_COLORS.yellow,
        score: c.priority_score,
        demo: c.id === demoCaseId ? 1 : 0
      }
    }))
  };
}

function addDataLayers(buildingsFC) {
  map.addSource('buildings', { type: 'geojson', data: buildingsFC });
  map.addLayer({
    id: 'buildings-fill',
    type: 'fill-extrusion',
    source: 'buildings',
    paint: {
      // Older fabric recedes, newer towers read slightly lighter/bluer.
      'fill-extrusion-color': [
        'step', ['coalesce', ['get', 'y'], 1920],
        '#161e30',
        1900, '#1a2438',
        1930, '#1e2a42',
        1960, '#243352',
        2000, '#2e4067'
      ],
      'fill-extrusion-height': ['*', ['get', 'h'], 0.3048],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.94,
      'fill-extrusion-vertical-gradient': true
    }
  });

  map.addSource('cases', { type: 'geojson', data: EMPTY_FC });
  map.addSource('pulse', { type: 'geojson', data: EMPTY_FC });
  map.addSource('route', { type: 'geojson', data: EMPTY_FC });

  map.addLayer({
    id: 'case-glow',
    type: 'circle',
    source: 'cases',
    paint: {
      'circle-color': ['get', 'color'],
      'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 20, 7, 100, 16],
      'circle-blur': 1,
      'circle-opacity': 0.4
    }
  });
  map.addLayer({
    id: 'case-core',
    type: 'circle',
    source: 'cases',
    paint: {
      'circle-color': ['get', 'color'],
      'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 20, 3, 100, 6.5],
      'circle-stroke-color': 'rgba(255,255,255,0.9)',
      'circle-stroke-width': ['case', ['==', ['get', 'demo'], 1], 2, 1]
    }
  });
  map.addLayer({
    id: 'pulse-ring',
    type: 'circle',
    source: 'pulse',
    paint: {
      'circle-color': 'rgba(0,0,0,0)',
      'circle-radius': 0,
      'circle-stroke-color': PIN_COLORS.red,
      'circle-stroke-width': 2,
      'circle-stroke-opacity': 0
    }
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ACCENT, 'line-width': 3.5, 'line-opacity': 0.95, 'line-dasharray': [0, 4, 3] }
  });

  map.on('click', 'case-core', (e) => {
    const id = e.features?.[0]?.properties?.id;
    const c = allCases.find((x) => x.id === id);
    if (c) flashQueueItem(c.id);
  });
  map.on('mouseenter', 'case-core', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'case-core', () => { map.getCanvas().style.cursor = ''; });
}

async function refreshCases() {
  const data = await fetchCases(500);
  allCases = data.cases;
  const src = map.getSource('cases');
  if (src) src.setData(casesToFC(allCases));
  renderQueue();
  renderStats();
}

// --- Workers (DOM markers) --------------------------------------------------

function upsertWorkers(workers) {
  for (const w of workers) {
    let entry = workerMarkers.get(w.id);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'crew';
      el.innerHTML = `<div class="crew__chip">${w.avatar}</div><div class="crew__dot"></div><div class="crew__tip">${w.name}<span>${w.role}</span></div>`;
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([w.long, w.lat]).addTo(map);
      entry = { marker, el, worker: w };
      workerMarkers.set(w.id, entry);
    }
    entry.worker = w;
    entry.el.dataset.status = w.status;
  }
  renderStats();
}

// ---------------------------------------------------------------------------
// Animations: idle orbit, pulse ring, route reveal + marching dashes
// ---------------------------------------------------------------------------

let userBusyUntil = 0;
let orbitOn = true;
for (const ev of ['mousedown', 'touchstart', 'wheel']) {
  map.on(ev, () => { userBusyUntil = Date.now() + 12000; });
}

function orbitTick() {
  if (orbitOn && Date.now() > userBusyUntil && !document.hidden) {
    map.setBearing(map.getBearing() + 0.012);
  }
  requestAnimationFrame(orbitTick);
}

let pulseActive = false;
function startPulse(lngLat, color) {
  map.getSource('pulse').setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: lngLat }, properties: {} }]
  });
  map.setPaintProperty('pulse-ring', 'circle-stroke-color', color);
  if (pulseActive) return;
  pulseActive = true;
  const t0 = performance.now();
  (function frame(now) {
    if (!pulseActive) return;
    const p = ((now - t0) % 1700) / 1700;
    map.setPaintProperty('pulse-ring', 'circle-radius', 6 + p * 46);
    map.setPaintProperty('pulse-ring', 'circle-stroke-opacity', 0.85 * (1 - p));
    requestAnimationFrame(frame);
  })(t0);
}
function stopPulse() {
  pulseActive = false;
  const src = map.getSource('pulse');
  if (src) src.setData(EMPTY_FC);
}

// Slight arc between two points so the route reads as a "dispatch", not a wire.
function arcBetween(a, b, segments = 48) {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const ctrl = [mx - dy * 0.25, my + dx * 0.25];
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * ctrl[0] + t ** 2 * b[0];
    const y = (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * ctrl[1] + t ** 2 * b[1];
    pts.push([x, y]);
  }
  return pts;
}

const DASH_SEQ = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5],
  [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2],
  [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]
];
let dashTimer = null;
let routeShown = false;

function showRoute(from, to, color) {
  const pts = arcBetween(from, to);
  const src = map.getSource('route');
  let i = 2;
  routeShown = true;
  map.setPaintProperty('route-line', 'line-color', color);
  const reveal = setInterval(() => {
    if (!routeShown) { clearInterval(reveal); return; }
    i = Math.min(pts.length, i + 3);
    src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.slice(0, i) }, properties: {} });
    if (i >= pts.length) clearInterval(reveal);
  }, 28);
  if (!dashTimer) {
    let step = 0;
    dashTimer = setInterval(() => {
      if (map.getLayer('route-line')) {
        map.setPaintProperty('route-line', 'line-dasharray', DASH_SEQ[step % DASH_SEQ.length]);
        step++;
      }
    }, 70);
  }
}
function solidRoute(color) {
  if (dashTimer) { clearInterval(dashTimer); dashTimer = null; }
  if (map.getLayer('route-line')) {
    map.setPaintProperty('route-line', 'line-dasharray', [1, 0]);
    map.setPaintProperty('route-line', 'line-color', color);
  }
}
function clearRoute() {
  routeShown = false;
  if (dashTimer) { clearInterval(dashTimer); dashTimer = null; }
  const src = map.getSource('route');
  if (src) src.setData(EMPTY_FC);
}

// ---------------------------------------------------------------------------
// Left panel: stats + ranked queue
// ---------------------------------------------------------------------------

function renderStats() {
  const open = allCases.length;
  const critical = allCases.filter((c) => c.priority_score >= 85).length;
  const clusters = new Set(
    allCases.filter((c) => c.pin_color === 'red' && c.duplicate_count >= 3)
      .map((c) => `${c.lat.toFixed(3)},${c.long.toFixed(3)},${c.ai_category}`)
  ).size;
  const crews = [...workerMarkers.values()].filter((e) => e.worker.status === 'available').length;
  document.getElementById('stat-open').textContent = open || '—';
  document.getElementById('stat-critical').textContent = String(critical);
  document.getElementById('stat-clusters').textContent = String(clusters);
  document.getElementById('stat-crews').textContent = workerMarkers.size ? String(crews) : '—';
}

const DOT_CLASS = { red: 'dot--critical', orange: 'dot--serious', yellow: 'dot--warning' };

function renderQueue() {
  const list = document.getElementById('queue-list');
  document.getElementById('queue-total').textContent = allCases.length;
  const top = allCases.slice(0, 12);
  list.innerHTML = top.map((c, i) => `
    <div class="qitem ${c.id === demoCaseId ? 'qitem--new' : ''}" data-id="${c.id}" data-lng="${c.long}" data-lat="${c.lat}">
      <div class="qitem__rank">${String(i + 1).padStart(2, '0')}</div>
      <div class="qitem__main">
        <div class="qitem__top">
          <i class="dot ${DOT_CLASS[c.pin_color]}"></i>
          <span class="qitem__cat">${CATEGORY_LABELS[c.ai_category]}</span>
          ${c.duplicate_count > 1 ? `<span class="qitem__dup">×${c.duplicate_count}</span>` : ''}
          ${c.id === demoCaseId ? (assignedNow ? '<span class="qitem__flag qitem__flag--good">CREW EN ROUTE</span>' : '<span class="qitem__flag">LIVE CALL</span>') : ''}
        </div>
        <div class="qitem__sum">${escapeHtml(c.ai_summary || c.raw_details || '—')}</div>
        <div class="qitem__meta">${escapeHtml(c.neighborhood || c.address || 'San Francisco')} · ${timeAgo(c.requested_at)}</div>
      </div>
      <div class="qitem__score" style="--sc:${scoreColor(c)}">${c.priority_score}</div>
    </div>`).join('');

  for (const el of list.querySelectorAll('.qitem')) {
    el.addEventListener('click', () => {
      userBusyUntil = Date.now() + 15000;
      map.flyTo({ center: [+el.dataset.lng, +el.dataset.lat], zoom: 15.6, pitch: 60, duration: 1600 });
    });
  }
}

function scoreColor(c) {
  return PIN_COLORS[c.pin_color] || PIN_COLORS.yellow;
}

function flashQueueItem(id) {
  const el = document.querySelector(`.qitem[data-id="${id}"]`);
  if (!el) return;
  el.classList.add('qitem--flash');
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setTimeout(() => el.classList.remove('qitem--flash'), 1600);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Right panel: live intake (transcript -> AI triage -> case -> crew match)
// ---------------------------------------------------------------------------

const intakeEl = document.getElementById('intake');
const transcriptEl = document.getElementById('transcript');
const triageEl = document.getElementById('triage');
const casecardEl = document.getElementById('casecard');
const matchEl = document.getElementById('match');

let shownLines = 0;
let shownFields = new Set();
let lastPhase = 'idle';
let assignedNow = false;
let caseOnMap = false;
let recommendedShown = false;

const FIELD_RENDER = {
  category: (v) => `<span class="chip chip--cat">${escapeHtml(CATEGORY_LABELS[v] || v)}</span>`,
  urgency: (v) => `<span class="chip chip--urg chip--urg-${escapeHtml(v)}">${escapeHtml(v).toUpperCase()}</span>`,
  location: (v) => escapeHtml(v),
  summary: (v) => escapeHtml(v)
};

function resetIntakeUI() {
  shownLines = 0;
  shownFields = new Set();
  assignedNow = false;
  caseOnMap = false;
  recommendedShown = false;
  demoCaseId = null;
  transcriptEl.innerHTML = '';
  triageEl.classList.add('triage--hidden');
  casecardEl.classList.add('casecard--hidden');
  matchEl.classList.add('match--hidden');
  document.getElementById('match-list').innerHTML = '';
  for (const row of triageEl.querySelectorAll('.triage__row')) row.classList.remove('triage__row--on');
  for (const v of triageEl.querySelectorAll('.triage__v')) v.innerHTML = '';
}

function renderTranscript(state) {
  const lines = state.transcript;
  while (shownLines < lines.length) {
    const ln = lines[shownLines];
    const b = document.createElement('div');
    b.className = `bubble bubble--${ln.speaker}`;
    b.innerHTML = `<div class="bubble__who">${ln.speaker === 'agent' ? 'SF311 Agent' : 'Caller'}</div>${escapeHtml(ln.text)}`;
    transcriptEl.appendChild(b);
    shownLines++;
  }
  let typing = transcriptEl.querySelector('.bubble--typing');
  const needTyping = state.phase === 'in_call' && !state.transcript_done;
  if (needTyping && !typing) {
    typing = document.createElement('div');
    typing.className = 'bubble bubble--typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    transcriptEl.appendChild(typing);
  } else if (!needTyping && typing) {
    typing.remove();
    typing = null;
  }
  if (typing && typing !== transcriptEl.lastChild) transcriptEl.appendChild(typing);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function typewrite(el, html, plain) {
  if (plain) {
    let i = 0;
    const text = html;
    el.classList.add('triage__v--typing');
    const t = setInterval(() => {
      i = Math.min(text.length, i + 3);
      el.textContent = text.slice(0, i);
      if (i >= text.length) { clearInterval(t); el.classList.remove('triage__v--typing'); }
    }, 12);
  } else {
    el.innerHTML = html;
  }
}

function renderTriage(state) {
  if (!state.extraction.revealed.length) return;
  triageEl.classList.remove('triage--hidden');
  for (const field of state.extraction.revealed) {
    if (shownFields.has(field)) continue;
    shownFields.add(field);
    const row = triageEl.querySelector(`.triage__row[data-field="${field}"]`);
    row.classList.add('triage__row--on');
    const v = document.getElementById(`tri-${field}`);
    const raw = state.extraction.fields[field];
    if (field === 'location' || field === 'summary') typewrite(v, raw, true);
    else v.innerHTML = FIELD_RENDER[field](raw);
  }
  const body = document.getElementById('intake-body');
  body.scrollTop = body.scrollHeight;
}

function onCaseCreated(state) {
  if (caseOnMap || !state.case) return;
  caseOnMap = true;
  demoCaseId = state.case.id;
  orbitOn = false;

  casecardEl.classList.remove('casecard--hidden');
  document.getElementById('casecard-title').textContent =
    `${CATEGORY_LABELS[state.case.ai_category]} — ${state.case.address}`;
  document.getElementById('casecard-meta').textContent =
    `${state.case.neighborhood} · priority ${state.case.priority_score} · case ${state.case.id.slice(-4)}`;

  refreshCases().then(() => {
    map.flyTo({
      center: [state.case.long, state.case.lat],
      zoom: 15.7, pitch: 61, bearing: -18,
      duration: 3200, essential: true
    });
    startPulse([state.case.long, state.case.lat], PIN_COLORS[state.case.pin_color] || PIN_COLORS.red);
  });
  const body = document.getElementById('intake-body');
  setTimeout(() => { body.scrollTop = body.scrollHeight; }, 60);
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, r = Math.PI / 180;
  const dp = (bLat - aLat) * r, dl = (bLng - aLng) * r;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function renderMatch(state) {
  if (!state.case) return;
  matchEl.classList.remove('match--hidden');
  const rec = state.recommendation;
  const head = document.getElementById('match-head');
  const list = document.getElementById('match-list');

  const rows = state.workers
    .map((w) => ({ w, d: haversineKm(state.case.lat, state.case.long, w.lat, w.long) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 4);

  if (!rec) {
    head.innerHTML = '<span class="scan"></span> Locating nearest qualified crew…';
    list.innerHTML = rows.map(({ w, d }) => `
      <div class="mrow mrow--scan" data-id="${w.id}">
        <div class="mrow__avatar">${w.avatar}</div>
        <div class="mrow__main"><b>${w.name}</b><span>${w.role} · ${d.toFixed(1)} km</span></div>
        <div class="mrow__state">${w.status === 'available' ? 'available' : 'on job'}</div>
      </div>`).join('');
    return;
  }

  if (!recommendedShown) {
    recommendedShown = true;
    const chosen = state.workers.find((w) => w.id === rec.worker_id);
    head.innerHTML = rec.status === 'accepted'
      ? '✓ Crew assigned'
      : 'Crew recommended — task sent to device';
    list.innerHTML = `
      <div class="mrow mrow--chosen" data-id="${chosen.id}">
        <div class="mrow__avatar mrow__avatar--chosen">${chosen.avatar}</div>
        <div class="mrow__main">
          <b>${chosen.name}</b>
          <span>${chosen.role} · ${chosen.vehicle}</span>
          <ul class="mrow__reasons">${rec.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        </div>
        <div class="mrow__eta"><b>${rec.eta_min}</b><span>min ETA</span></div>
      </div>
      <div class="mrow__status" id="match-status">${rec.status === 'accepted' ? '' : 'Awaiting acceptance on worker device…'}</div>`;

    const chosenEntry = workerMarkers.get(rec.worker_id);
    if (chosenEntry) {
      chosenEntry.el.classList.add('crew--chosen');
      showRoute(
        [chosenEntry.worker.long, chosenEntry.worker.lat],
        [state.case.long, state.case.lat],
        ACCENT
      );
      userBusyUntil = 0;
      const b = new maplibregl.LngLatBounds();
      b.extend([chosenEntry.worker.long, chosenEntry.worker.lat]);
      b.extend([state.case.long, state.case.lat]);
      map.fitBounds(b, { padding: { top: 140, bottom: 90, left: 380, right: 420 }, pitch: 48, bearing: -14, duration: 2400, maxZoom: 15.2 });
      toast(`Task recommended to ${chosenEntry.worker.name} · ${rec.distance_km} km away`);
    }
    const body = document.getElementById('intake-body');
    setTimeout(() => { body.scrollTop = body.scrollHeight; }, 80);
  }
}

function onAccepted(state) {
  if (assignedNow) return;
  assignedNow = true;
  const rec = state.recommendation;
  const chosen = state.workers.find((w) => w.id === rec.worker_id);
  document.getElementById('match-head').innerHTML = '✓ Crew assigned';
  const status = document.getElementById('match-status');
  if (status) { status.innerHTML = `<span class="ok">✓ ${chosen.name} accepted — en route</span>`; }
  solidRoute(GOOD);
  stopPulse();
  startPulse([state.case.long, state.case.lat], GOOD);
  renderQueue();
  toast(`${chosen.name} accepted the task — en route to ${state.case.address}`, 'good');
}

// ---------------------------------------------------------------------------
// State machine glue — poll every second, react to phase changes
// ---------------------------------------------------------------------------

function fmtTimer(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function applyState(state) {
  upsertWorkers(state.workers);

  const active = state.phase !== 'idle';
  intakeEl.classList.toggle('intake--hidden', !active);
  document.getElementById('btn-call').classList.toggle('btn--busy', active && state.phase !== 'accepted');

  if (state.phase === 'idle') {
    if (lastPhase !== 'idle') {
      // reset happened elsewhere
      resetIntakeUI();
      clearRoute();
      stopPulse();
      orbitOn = true;
      for (const e of workerMarkers.values()) e.el.classList.remove('crew--chosen');
      refreshCases();
      map.flyTo({ ...HOME, duration: 2500 });
    }
    lastPhase = 'idle';
    return;
  }

  document.getElementById('intake-caller').textContent =
    `${state.caller.name} · ${state.caller.line}`;
  document.getElementById('call-timer').textContent = fmtTimer(state.elapsed);
  document.getElementById('rec-dot').classList.toggle('rec--live', state.phase === 'ringing' || state.phase === 'in_call');

  renderTranscript(state);
  renderTriage(state);
  if (state.case) onCaseCreated(state);
  if (state.phase === 'matching' || state.phase === 'recommended' || state.phase === 'accepted') renderMatch(state);
  if (state.phase === 'accepted' && state.recommendation) onAccepted(state);

  lastPhase = state.phase;
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const state = await fetchDemoState();
    applyState(state);
  } catch (e) {
    console.warn('[triage] poll failed:', e.message);
  } finally {
    polling = false;
  }
}

// --- Toast, clock, controls -------------------------------------------------

let toastTimer = null;
function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${kind ? `toast--${kind}` : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('toast--hidden'), 5200);
}

setInterval(() => {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('en-US', { hour12: false });
}, 1000);

document.getElementById('btn-call').addEventListener('click', async () => {
  await startCall();
  poll();
});
document.getElementById('btn-reset').addEventListener('click', async () => {
  await resetDemo();
  resetIntakeUI();
  clearRoute();
  stopPulse();
  orbitOn = true;
  for (const e of workerMarkers.values()) e.el.classList.remove('crew--chosen');
  await refreshCases();
  map.flyTo({ ...HOME, duration: 2200 });
  lastPhase = 'idle';
});
document.getElementById('credits-toggle').addEventListener('click', () => {
  document.getElementById('credits').classList.toggle('credits--open');
});

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

map.on('load', async () => {
  try {
    const buildings = await loadBuildings();
    boot.set('raising the skyline…', 74);
    addDataLayers(buildings);
    boot.set('loading 311 snapshot…', 84);
    await refreshCases();
    boot.set('checking crew radios…', 94);
    await poll();
    map.once('idle', () => boot.done());
    setTimeout(() => boot.done(), 9000); // never trap the demo on the loader
    orbitTick();
    setInterval(poll, 1000);
  } catch (err) {
    console.error(err);
    boot.set(`error: ${err.message} — is the backend on :8000?`, 0);
  }
});
