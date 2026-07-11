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
  light: { anchor: 'viewport', color: '#ffe9c4', intensity: 0.5, position: [1.4, 200, 50] },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#4C4C35' } },
    { id: 'carto-dark', type: 'raster', source: 'carto-dark', paint: { 'raster-opacity': 0.9, 'raster-saturation': -0.1 } },
    { id: 'carto-labels', type: 'raster', source: 'carto-labels', paint: { 'raster-opacity': 0.55 } }
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
let workersById = new Map();
let chosenWorkerId = null;
let demoCaseId = null;

const ISSUE_ICONS = {
  pothole: { color: '#d85b62', code: 'PT' },
  streetlight: { color: '#568bd8', code: 'SL' },
  graffiti: { color: '#8b72c7', code: 'GR' },
  illegal_dumping: { color: '#c77850', code: 'DP' },
  water_leak: { color: '#3d91ad', code: 'WT' },
  encampment: { color: '#4b9b78', code: 'EN' },
  other: { color: '#718096', code: '311' }
};

function issueIconMarkup(category, className = 'qitem__issue') {
  const icon = ISSUE_ICONS[category] || ISSUE_ICONS.other;
  return `<span class="${className}" style="--issue:${icon.color}" aria-hidden="true">${icon.code}</span>`;
}

function issueMarkerSvg(category) {
  const icon = ISSUE_ICONS[category] || ISSUE_ICONS.other;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="72" viewBox="0 0 64 72">
    <defs><filter id="s" x="-30%" y="-25%" width="160%" height="170%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#02060b" flood-opacity=".55"/></filter></defs>
    <g filter="url(#s)"><circle cx="32" cy="30" r="24" fill="#111b2a" stroke="#f4f7fb" stroke-width="3"/><circle cx="32" cy="30" r="19" fill="${icon.color}"/><path d="M27 52l5 10 5-10" fill="#f4f7fb"/></g>
    <text x="32" y="35" text-anchor="middle" fill="#fff" font-family="Arial, sans-serif" font-size="15" font-weight="700" letter-spacing=".4">${icon.code}</text>
  </svg>`;
}

function workerMarkerSvg(label, chosen = false) {
  const stroke = chosen ? '#50b985' : '#7f96b5';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="72" viewBox="0 0 64 72">
    <defs><filter id="s" x="-30%" y="-25%" width="160%" height="170%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#02060b" flood-opacity=".6"/></filter></defs>
    <g filter="url(#s)"><circle cx="32" cy="30" r="24" fill="#101a29" stroke="${stroke}" stroke-width="${chosen ? 5 : 3}"/><path d="M27 52l5 10 5-10" fill="${stroke}"/></g>
    <text x="32" y="35" text-anchor="middle" fill="#eef3fa" font-family="Arial, sans-serif" font-size="14" font-weight="700">${label}</text>
  </svg>`;
}

async function registerIssueIcons() {
  const images = Object.keys(ISSUE_ICONS).map(async (category) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(issueMarkerSvg(category))}`;
    await image.decode();
    map.addImage(`issue-${category}`, image, { pixelRatio: 2 });
  });
  await Promise.all(images);
}

function casesToFC(cases) {
  return {
    type: 'FeatureCollection',
    features: cases.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.long, c.lat] },
      properties: {
        id: c.id,
        color: PIN_COLORS[c.pin_color] || PIN_COLORS.yellow,
        category: c.ai_category in ISSUE_ICONS ? c.ai_category : 'other',
        score: c.priority_score,
        demo: c.id === demoCaseId ? 1 : 0
      }
    }))
  };
}

async function addDataLayers(buildingsFC) {
  map.addSource('buildings', { type: 'geojson', data: buildingsFC });
  map.addLayer({
    id: 'buildings-fill',
    type: 'fill-extrusion',
    source: 'buildings',
    paint: {
      // Exact San Francisco era ramp from the upstream Skyline Project.
      'fill-extrusion-color': [
        'step', ['coalesce', ['get', 'y'], 1900],
        '#656743',
        1900, '#FFE270',
        1930, '#858839',
        1960, '#DCFF3E',
        2000, '#DFB836'
      ],
      'fill-extrusion-height': ['*', ['get', 'h'], 0.3048],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.95,
      'fill-extrusion-vertical-gradient': true
    }
  });

  map.addSource('cases', { type: 'geojson', data: EMPTY_FC });
  map.addSource('pulse', { type: 'geojson', data: EMPTY_FC });
  map.addSource('route', { type: 'geojson', data: EMPTY_FC });
  map.addSource('workers', { type: 'geojson', data: EMPTY_FC });

  await registerIssueIcons();

  map.addLayer({
    id: 'case-symbols',
    type: 'symbol',
    source: 'cases',
    layout: {
      'icon-image': ['concat', 'issue-', ['get', 'category']],
      'icon-size': [
        'interpolate', ['linear'], ['zoom'],
        10.8, 0.95,
        12.5, 1.15,
        14.5, 1.45,
        16.5, 1.85,
        18, 2.15
      ],
      'icon-anchor': 'bottom',
      'icon-allow-overlap': false,
      'icon-ignore-placement': false,
      'symbol-sort-key': ['-', 110, ['get', 'score']]
    },
    paint: {
      'icon-opacity': 0.98,
      'icon-halo-color': '#ffffff',
      'icon-halo-width': ['case', ['==', ['get', 'demo'], 1], 2, 0]
    }
  });
  map.addLayer({
    id: 'worker-symbols',
    type: 'symbol',
    source: 'workers',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': [
        'interpolate', ['linear'], ['zoom'],
        10.8, 1,
        13, 1.25,
        15, 1.55,
        18, 2
      ],
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-pitch-alignment': 'viewport',
      'icon-rotation-alignment': 'viewport'
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

  map.on('click', 'case-symbols', (e) => {
    const id = e.features?.[0]?.properties?.id;
    const c = allCases.find((x) => x.id === id);
    if (c) flashQueueItem(c.id);
  });
  map.on('mouseenter', 'case-symbols', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'case-symbols', () => { map.getCanvas().style.cursor = ''; });
}

async function refreshCases() {
  const data = await fetchCases(500);
  allCases = data.cases;
  const src = map.getSource('cases');
  if (src) src.setData(casesToFC(allCases));
  renderQueue();
  renderStats();
}

// --- Workers (native map symbols; no HTML-overlay parallax) -----------------

function renderWorkersSource() {
  const source = map.getSource('workers');
  if (!source) return;
  source.setData({
    type: 'FeatureCollection',
    features: [...workersById.values()].map((worker) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [worker.long, worker.lat] },
      properties: {
        id: worker.id,
        status: worker.status,
        icon: `crew-${worker.id}${worker.id === chosenWorkerId ? '-chosen' : ''}`
      }
    }))
  });
}

const workerImagePromises = new Map();

function ensureWorkerImages(worker) {
  if (workerImagePromises.has(worker.id)) return workerImagePromises.get(worker.id);
  const promise = Promise.all([false, true].map(async (chosen) => {
    const name = `crew-${worker.id}${chosen ? '-chosen' : ''}`;
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(workerMarkerSvg(worker.avatar, chosen))}`;
    await image.decode();
    if (!map.hasImage(name)) map.addImage(name, image, { pixelRatio: 2 });
  }));
  workerImagePromises.set(worker.id, promise);
  return promise;
}

function upsertWorkers(workers) {
  for (const worker of workers) workersById.set(worker.id, worker);
  Promise.all(workers.map(ensureWorkerImages)).then(renderWorkersSource);
  renderStats();
}

// ---------------------------------------------------------------------------
// Animations: pulse ring, route reveal + marching dashes
// ---------------------------------------------------------------------------

let userBusyUntil = 0;
for (const ev of ['mousedown', 'touchstart', 'wheel']) map.on(ev, () => { userBusyUntil = Date.now() + 12000; });

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
  const crews = [...workersById.values()].filter((worker) => worker.status === 'available').length;
  document.getElementById('stat-open').textContent = open || '—';
  document.getElementById('stat-critical').textContent = String(critical);
  document.getElementById('stat-clusters').textContent = String(clusters);
  document.getElementById('stat-crews').textContent = workersById.size ? String(crews) : '—';
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  document.getElementById('queue-total').textContent = allCases.length;
  const top = allCases.slice(0, 12);
  list.innerHTML = top.map((c, i) => `
    <div class="qitem ${c.id === demoCaseId ? 'qitem--new' : ''}" data-id="${c.id}" data-lng="${c.long}" data-lat="${c.lat}">
      <div class="qitem__rank">${String(i + 1).padStart(2, '0')}</div>
      <div class="qitem__main">
        <div class="qitem__top">
          ${issueIconMarkup(c.ai_category)}
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

    const chosenWorker = workersById.get(rec.worker_id);
    if (chosenWorker) {
      chosenWorkerId = chosenWorker.id;
      renderWorkersSource();
      showRoute(
        [chosenWorker.long, chosenWorker.lat],
        [state.case.long, state.case.lat],
        ACCENT
      );
      userBusyUntil = 0;
      const b = new maplibregl.LngLatBounds();
      b.extend([chosenWorker.long, chosenWorker.lat]);
      b.extend([state.case.long, state.case.lat]);
      const compact = map.getContainer().clientWidth < 1100;
      map.fitBounds(b, {
        padding: compact
          ? { top: 100, bottom: 80, left: 110, right: 110 }
          : { top: 140, bottom: 90, left: 380, right: 420 },
        pitch: 48, bearing: -14, duration: 2400, maxZoom: 15.2
      });
      toast(`Task recommended to ${chosenWorker.name} · ${rec.distance_km} km away`);
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
      chosenWorkerId = null;
      renderWorkersSource();
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
  chosenWorkerId = null;
  renderWorkersSource();
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
    await addDataLayers(buildings);
    boot.set('loading 311 snapshot…', 84);
    await refreshCases();
    boot.set('checking crew radios…', 94);
    await poll();
    map.once('idle', () => boot.done());
    setTimeout(() => boot.done(), 9000); // never trap the demo on the loader
    setInterval(poll, 1000);
  } catch (err) {
    console.error(err);
    boot.set(`error: ${err.message} — is the backend on :8000?`, 0);
  }
});
