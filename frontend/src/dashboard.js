import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import {
  fetchCases, fetchDemoState, startCall, resetDemo,
  CATEGORY_LABELS, PIN_COLORS, GOOD, ACCENT, timeAgo
} from './api.js';
import { CATEGORY_COLORS, glyphSvg, casePinSvg, crewBadgeSvg } from './icons.js';

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
window.__map = map;

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
let selectedCaseId = null;
let activeQueueStatus = 'all';
let lastSyncAt = null;
const workflowOverrides = new Map();
const priorityOverrides = new Map();
const duplicateOverrides = new Map();

function issueIconMarkup(category, className = 'qitem__issue') {
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
  return `<span class="${className}" style="--issue:${color}" aria-hidden="true">${glyphSvg(category)}</span>`;
}

async function svgToImage(svg) {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  return image;
}

async function registerMarkerImages() {
  const entries = [
    ...Object.keys(CATEGORY_COLORS).map((c) => [`issue-${c}`, casePinSvg(c)]),
    ['crew-available', crewBadgeSvg()],
    ['crew-busy', crewBadgeSvg({ busy: true })],
    ['crew-chosen', crewBadgeSvg({ chosen: true })]
  ];
  await Promise.all(entries.map(async ([name, svg]) => {
    map.addImage(name, await svgToImage(svg), { pixelRatio: 2 });
  }));
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
        category: c.ai_category in CATEGORY_COLORS ? c.ai_category : 'other',
        score: c.priority_score,
        demo: c.id === demoCaseId ? 1 : 0
      }
    }))
  };
}

async function addDataLayers(buildingsFC) {
  // Generated ids let MapLibre keep hover/selection state without bloating the
  // 38 MB source file with another property on every footprint.
  map.addSource('buildings', { type: 'geojson', data: buildingsFC, generateId: true });
  map.addLayer({
    id: 'buildings-fill',
    type: 'fill-extrusion',
    source: 'buildings',
    paint: {
      // Exact San Francisco era ramp from the upstream Skyline Project.
      'fill-extrusion-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], '#8fc4ff',
        ['boolean', ['feature-state', 'hover'], false], '#f1f7c2',
        [
          'step', ['coalesce', ['get', 'y'], 1900],
          '#656743',
          1900, '#FFE270',
          1930, '#858839',
          1960, '#DCFF3E',
          2000, '#DFB836'
        ]
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

  await registerMarkerImages();

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
    if (c) {
      flashQueueItem(c.id);
      openCasePanel(c);
    }
  });
  map.on('mouseenter', 'case-symbols', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'case-symbols', () => { map.getCanvas().style.cursor = ''; });

  // Keep case pins as the top click target, then inspect the building beneath
  // every other map click. The small-radius fallback makes narrow footprints
  // usable without turning roads and parks into false positives.
  map.on('click', (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ['case-symbols'] }).length) return;
    let hit = map.queryRenderedFeatures(e.point, { layers: ['buildings-fill'] })[0];
    if (!hit) {
      const p = e.point;
      hit = map.queryRenderedFeatures(
        [[p.x - 5, p.y - 5], [p.x + 5, p.y + 5]],
        { layers: ['buildings-fill'] }
      )[0];
    }
    if (!hit) {
      closeBuildingPanel();
      return;
    }
    setSelectedBuilding(hit.id);
    openBuildingPanel(hit.properties, e.lngLat);
  });

  map.on('mousemove', 'buildings-fill', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    setHoveredBuilding(e.features?.[0]?.id ?? null);
  });
  map.on('mouseleave', 'buildings-fill', () => {
    map.getCanvas().style.cursor = '';
    setHoveredBuilding(null);
  });
}

// ---------------------------------------------------------------------------
// Building inspector — adapted to the compact SF311 operations UI
// ---------------------------------------------------------------------------

const buildingPanelEl = document.getElementById('building-panel');
let selectedBuildingId = null;
let hoveredBuildingId = null;

function setSelectedBuilding(id) {
  if (selectedBuildingId === id) return;
  if (selectedBuildingId !== null) {
    try { map.setFeatureState({ source: 'buildings', id: selectedBuildingId }, { selected: false }); } catch {}
  }
  selectedBuildingId = id;
  if (id !== null) {
    try { map.setFeatureState({ source: 'buildings', id }, { selected: true }); } catch {}
  }
}

function setHoveredBuilding(id) {
  if (hoveredBuildingId === id) return;
  if (hoveredBuildingId !== null) {
    try { map.setFeatureState({ source: 'buildings', id: hoveredBuildingId }, { hover: false }); } catch {}
  }
  hoveredBuildingId = id;
  if (id !== null) {
    try { map.setFeatureState({ source: 'buildings', id }, { hover: true }); } catch {}
  }
}

function buildingEra(year) {
  if (!year) return { label: 'Year unknown', color: '#7f8460' };
  if (year < 1900) return { label: 'Pre-1900', color: '#656743' };
  if (year < 1930) return { label: 'Early 20th century', color: '#FFE270' };
  if (year < 1960) return { label: '1930–1959', color: '#858839' };
  if (year < 2000) return { label: '1960–1999', color: '#DCFF3E' };
  return { label: 'Contemporary', color: '#DFB836' };
}

function openBuildingPanel(properties = {}, lngLat) {
  closeCasePanel();
  const yearValue = Number(properties.y);
  const year = Number.isFinite(yearValue) && yearValue > 1700 ? Math.round(yearValue) : null;
  const heightValue = Number(properties.h);
  const heightFt = Number.isFinite(heightValue) && heightValue > 0 ? heightValue : null;
  const era = buildingEra(year);
  const nearby = allCases.filter((c) =>
    haversineKm(lngLat.lat, lngLat.lng, c.lat, c.long) <= 0.15
  ).length;

  document.getElementById('building-title').textContent = year ? `${era.label} building` : 'Building footprint';
  document.getElementById('building-era').textContent = era.label;
  document.getElementById('building-era-swatch').style.background = era.color;
  document.getElementById('building-year').textContent = year ? String(year) : 'Not recorded';
  document.getElementById('building-height').textContent = heightFt
    ? `${Math.round(heightFt)} ft · ${Math.round(heightFt * 0.3048)} m`
    : 'Not recorded';
  document.getElementById('building-floors').textContent = heightFt
    ? `≈ ${Math.max(1, Math.round(heightFt / 11))}`
    : 'Not available';
  document.getElementById('building-location').textContent =
    `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
  document.getElementById('building-nearby-count').textContent = String(nearby);
  buildingPanelEl.classList.remove('building-panel--hidden');
}

function closeBuildingPanel() {
  buildingPanelEl.classList.add('building-panel--hidden');
  setSelectedBuilding(null);
}

document.getElementById('building-panel-close').addEventListener('click', closeBuildingPanel);

async function refreshCases() {
  const data = await fetchCases(500);
  allCases = data.cases;
  lastSyncAt = Date.now();
  setConnectionState('connected');
  const src = map.getSource('cases');
  if (src) src.setData(casesToFC(allCases));
  renderQueue();
  renderStats();
}

// --- Workers (native map symbols; no HTML-overlay parallax) -----------------

function workerIconName(worker) {
  if (worker.id === chosenWorkerId) return 'crew-chosen';
  return worker.status === 'available' ? 'crew-available' : 'crew-busy';
}

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
        icon: workerIconName(worker)
      }
    }))
  });
}

function upsertWorkers(workers) {
  for (const worker of workers) workersById.set(worker.id, worker);
  renderWorkersSource();
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
  const active = allCases.filter((c) => workflowStatus(c) !== 'resolved');
  const critical = active.filter((c) => effectiveScore(c) >= 85 && workflowStatus(c) === 'unassigned').length;
  const slaRisk = active.filter((c) => effectiveScore(c) >= 75 && workflowStatus(c) === 'unassigned').length;
  const crews = [...workersById.values()].filter((worker) => worker.status === 'available').length;
  document.getElementById('stat-open').textContent = active.length || '—';
  document.getElementById('stat-critical').textContent = String(critical);
  document.getElementById('stat-clusters').textContent = String(slaRisk);
  document.getElementById('stat-crews').textContent = workersById.size ? String(crews) : '—';
  document.getElementById('stat-crews-trend').textContent = workersById.size ? `${workersById.size} crews on shift` : 'Checking roster';
}

function idBucket(c, modulo) {
  return [...String(c.id)].reduce((sum, ch) => sum + (Number(ch) || 0), 0) % modulo;
}

function workflowStatus(c) {
  if (workflowOverrides.has(c.id)) return workflowOverrides.get(c.id);
  if (c.id === demoCaseId && assignedNow) return 'in_progress';
  if (effectiveScore(c) >= 85) return 'unassigned';
  if (idBucket(c, 17) === 0) return 'in_progress';
  if (idBucket(c, 11) === 0) return 'dispatched';
  return 'unassigned';
}

function statusLabel(status) {
  return ({ unassigned: 'Unassigned', dispatched: 'Dispatched', in_progress: 'In progress', resolved: 'Resolved' })[status] || 'Unassigned';
}

function effectiveScore(c) {
  if (priorityOverrides.has(c.id)) return priorityOverrides.get(c.id);
  return Number(c.priority_score) || 0;
}

function severityKey(c) {
  const score = effectiveScore(c);
  if (score >= 85) return 'critical';
  if (score >= 60) return 'elevated';
  return 'routine';
}

function shortAddress(c) {
  if (!c.address) return c.neighborhood || 'San Francisco';
  return c.address.split(',')[0].toLowerCase()
    .replace(/\b([a-z])/g, (m, ch) => ch.toUpperCase())
    .replace(/\b(\d+)(Th|St|Nd|Rd)\b/g, (m, num, suffix) => num + suffix.toLowerCase());
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  const state = document.getElementById('queue-state');
  const query = document.getElementById('case-search').value.trim().toLowerCase();
  const severity = document.getElementById('severity-filter').value;
  const category = document.getElementById('category-filter').value;
  const sort = document.getElementById('sort-filter').value;
  const active = allCases.filter((c) => workflowStatus(c) !== 'resolved');
  const counts = active.reduce((acc, c) => { acc[workflowStatus(c)]++; return acc; }, { unassigned: 0, dispatched: 0, in_progress: 0 });
  document.getElementById('count-all').textContent = active.length;
  document.getElementById('count-unassigned').textContent = counts.unassigned;
  document.getElementById('count-dispatched').textContent = counts.dispatched;
  document.getElementById('count-in-progress').textContent = counts.in_progress;

  let filtered = active.filter((c) => {
    const haystack = `${c.id} ${c.address || ''} ${c.neighborhood || ''} ${c.ai_summary || ''}`.toLowerCase();
    return (!query || haystack.includes(query))
      && (severity === 'all' || severityKey(c) === severity)
      && (category === 'all' || c.ai_category === category)
      && (activeQueueStatus === 'all' || workflowStatus(c) === activeQueueStatus);
  });
  filtered.sort((a, b) => {
    if (sort === 'oldest') return new Date(a.requested_at) - new Date(b.requested_at);
    if (sort === 'newest') return new Date(b.requested_at) - new Date(a.requested_at);
    return effectiveScore(b) - effectiveScore(a) || new Date(a.requested_at) - new Date(b.requested_at);
  });
  document.getElementById('queue-total').textContent = filtered.length;
  state.classList.toggle('queue__state--hidden', filtered.length > 0);
  state.innerHTML = filtered.length ? '' : '<b>No cases match this view</b><span>Adjust the search or filters to see more cases.</span><button type="button" id="clear-filters">Clear filters</button>';
  if (!filtered.length) {
    list.innerHTML = '';
    document.getElementById('clear-filters').addEventListener('click', clearQueueFilters);
    return;
  }
  const top = filtered.slice(0, 80);
  list.innerHTML = top.map((c) => `
    <button class="qitem ${c.id === demoCaseId ? 'qitem--new' : ''} ${c.id === selectedCaseId ? 'qitem--selected' : ''}" data-id="${c.id}" data-lng="${c.long}" data-lat="${c.lat}" style="--sev:${scoreColor(c)}" type="button">
      ${issueIconMarkup(c.ai_category)}
      <div class="qitem__main">
        <div class="qitem__top">
          <span class="qitem__cat">${CATEGORY_LABELS[c.ai_category] || 'General'}</span>
          ${effectiveDuplicates(c) > 1 ? `<span class="qitem__dup">${effectiveDuplicates(c)} reports</span>` : ''}
          ${c.id === demoCaseId ? (assignedNow ? '<span class="qitem__flag qitem__flag--good">Crew en route</span>' : '<span class="qitem__flag">Live call</span>') : ''}
          <span class="qitem__time">${timeAgo(c.requested_at)}</span>
        </div>
        <div class="qitem__sum">${escapeHtml(c.ai_summary || c.raw_details || '—')}</div>
        <div class="qitem__meta"><span class="qitem__status qitem__status--${workflowStatus(c)}">${statusLabel(workflowStatus(c))}</span>${escapeHtml(shortAddress(c))} · #${escapeHtml(String(c.id).slice(-6))}</div>
      </div>
      <div class="qitem__score">
        <b>${effectiveScore(c)}</b><small>${severityKey(c)}</small>
        <span class="qitem__meter"><i style="width:${Math.min(100, effectiveScore(c))}%"></i></span>
      </div>
    </button>`).join('');

  for (const el of list.querySelectorAll('.qitem')) {
    el.addEventListener('click', () => {
      userBusyUntil = Date.now() + 15000;
      const c = allCases.find((item) => item.id === el.dataset.id);
      if (c) openCasePanel(c);
      map.flyTo({ center: [+el.dataset.lng, +el.dataset.lat], zoom: 15.6, pitch: 60, duration: 1600 });
    });
  }
}

function clearQueueFilters() {
  document.getElementById('case-search').value = '';
  document.getElementById('severity-filter').value = 'all';
  document.getElementById('category-filter').value = 'all';
  document.getElementById('sort-filter').value = 'priority';
  activeQueueStatus = 'all';
  for (const tab of document.querySelectorAll('.queue__tab')) {
    const active = tab.dataset.status === 'all';
    tab.classList.toggle('queue__tab--active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  renderQueue();
}

function scoreColor(c) {
  return severityKey(c) === 'critical' ? PIN_COLORS.red : severityKey(c) === 'elevated' ? PIN_COLORS.orange : PIN_COLORS.yellow;
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
// Case record: human review, workflow actions, and audit context
// ---------------------------------------------------------------------------

const casePanelEl = document.getElementById('case-panel');

function effectiveDuplicates(c) {
  return duplicateOverrides.get(c.id) ?? c.duplicate_count ?? 1;
}

function aiReasons(c) {
  const reasons = [];
  if (c.safety_risk) reasons.push('Potential immediate public-safety hazard');
  if (c.ai_urgency === 'critical' || c.ai_urgency === 'high') reasons.push(`${c.ai_urgency === 'critical' ? 'Critical' : 'High'} urgency detected in report details`);
  if (effectiveDuplicates(c) > 1) reasons.push(`${effectiveDuplicates(c)} nearby reports indicate a recurring incident`);
  if (c.ai_category === 'pothole') reasons.push('Roadway issue may affect vehicles, cyclists, or access');
  if (c.ai_category === 'water_leak') reasons.push('Water infrastructure issue may worsen without intervention');
  if (!reasons.length) reasons.push('Routine service request with no immediate safety indicators');
  return reasons.slice(0, 3);
}

function timelineMarkup(c) {
  const status = workflowStatus(c);
  const received = new Date(c.requested_at);
  const triaged = new Date(received.getTime() + 2 * 60000);
  const items = [
    ['Report received', `${c.source || '311 channel'} · ${received.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`],
    ['AI triage completed', `Priority ${effectiveScore(c)} · ${Math.min(98, 89 + idBucket(c, 9))}% confidence`]
  ];
  if (status === 'dispatched' || status === 'in_progress') items.push(['Dispatch created', status === 'in_progress' ? 'Accepted by field crew' : 'Awaiting crew acceptance']);
  if (status === 'in_progress') items.push(['Crew en route', 'Location shared with assigned unit']);
  if (status === 'resolved') items.push(['Case resolved', 'Closed by dispatch operator']);
  return items.map(([title, meta], index) => `<li class="${index === items.length - 1 ? 'timeline__item--current' : ''}"><i></i><div><b>${escapeHtml(title)}</b><span>${escapeHtml(meta)}</span></div></li>`).join('');
}

function openCasePanel(c) {
  if (!c) return;
  closeBuildingPanel();
  selectedCaseId = c.id;
  const status = workflowStatus(c);
  const confidence = Math.min(98, 89 + idBucket(c, 9));
  document.getElementById('detail-case-id').textContent = `CASE #${String(c.id).slice(-8)}`;
  document.getElementById('detail-title').textContent = CATEGORY_LABELS[c.ai_category] || 'General service request';
  document.getElementById('detail-status').textContent = statusLabel(status);
  document.getElementById('detail-status').className = `status-pill status-pill--${status}`;
  document.getElementById('detail-age').textContent = `Received ${timeAgo(c.requested_at)}`;
  document.getElementById('detail-summary').textContent = c.ai_summary || c.raw_details || 'No description provided.';
  document.getElementById('detail-address').textContent = shortAddress(c);
  document.getElementById('detail-neighborhood').textContent = c.neighborhood || 'San Francisco';
  document.getElementById('detail-score').textContent = effectiveScore(c);
  document.getElementById('detail-severity').textContent = severityKey(c);
  document.getElementById('detail-confidence').textContent = `${confidence}% confidence`;
  document.getElementById('detail-reasons').innerHTML = aiReasons(c).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');
  document.getElementById('detail-category').textContent = CATEGORY_LABELS[c.ai_category] || 'General';
  document.getElementById('detail-source').textContent = c.source || '311 intake';
  document.getElementById('detail-duplicates').textContent = effectiveDuplicates(c) > 1 ? `${effectiveDuplicates(c)} linked reports` : 'No linked reports';
  document.getElementById('detail-unit').textContent = status === 'in_progress' ? 'Crew 3 · PW-214' : status === 'dispatched' ? 'Pending acceptance' : 'Not assigned';
  document.getElementById('detail-timeline').innerHTML = timelineMarkup(c);
  document.getElementById('detail-priority').value = severityKey(c);
  document.getElementById('detail-assign').disabled = status === 'in_progress' || status === 'resolved';
  document.getElementById('detail-assign').textContent = status === 'dispatched' ? 'Reassign crew' : status === 'in_progress' ? 'Crew assigned' : 'Assign crew';
  document.getElementById('detail-resolve').disabled = status === 'resolved';
  casePanelEl.classList.remove('case-panel--hidden');
  renderQueue();
}

function closeCasePanel() {
  if (!casePanelEl) return;
  casePanelEl.classList.add('case-panel--hidden');
  selectedCaseId = null;
  if (document.getElementById('queue-list')) renderQueue();
}

function selectedCase() {
  return allCases.find((c) => c.id === selectedCaseId);
}

document.getElementById('case-panel-close').addEventListener('click', closeCasePanel);
document.getElementById('detail-copy-id').addEventListener('click', async () => {
  const c = selectedCase();
  if (!c) return;
  try { await navigator.clipboard.writeText(c.id); toast(`Case ${String(c.id).slice(-8)} copied`); }
  catch { toast(`Case ID: ${c.id}`); }
});
document.getElementById('detail-priority').addEventListener('change', (event) => {
  const c = selectedCase();
  if (!c) return;
  priorityOverrides.set(c.id, ({ critical: 95, elevated: 75, routine: 40 })[event.target.value]);
  openCasePanel(c);
  renderStats();
  toast(`Priority updated for case ${String(c.id).slice(-6)}`, 'good');
});
document.getElementById('detail-assign').addEventListener('click', () => {
  const c = selectedCase();
  if (!c) return;
  workflowOverrides.set(c.id, 'dispatched');
  openCasePanel(c);
  renderStats();
  toast('Dispatch created · awaiting crew acceptance', 'good');
});
document.getElementById('detail-merge').addEventListener('click', () => {
  const c = selectedCase();
  if (!c) return;
  duplicateOverrides.set(c.id, effectiveDuplicates(c) + 1);
  openCasePanel(c);
  toast('Duplicate report linked to this incident', 'good');
});
document.getElementById('detail-resolve').addEventListener('click', () => {
  const c = selectedCase();
  if (!c) return;
  workflowOverrides.set(c.id, 'resolved');
  closeCasePanel();
  renderStats();
  toast(`Case ${String(c.id).slice(-6)} resolved`, 'good');
});

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
    head.innerHTML = '<span class="scan"></span> Locating nearest crew…';
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
      : 'Crew recommended · task sent';
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
    lastSyncAt = Date.now();
    setConnectionState('connected');
    applyState(state);
  } catch (e) {
    console.warn('[triage] poll failed:', e.message);
    setConnectionState('degraded');
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

function setConnectionState(state) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.classList.toggle('sync--degraded', state === 'degraded');
  el.querySelector('b').textContent = state === 'degraded' ? 'Data feed reconnecting' : 'Data feed connected';
}

function updateSyncAge() {
  const el = document.getElementById('sync-age');
  if (!el) return;
  if (!lastSyncAt) { el.textContent = 'Connecting…'; return; }
  const seconds = Math.max(0, Math.floor((Date.now() - lastSyncAt) / 1000));
  el.textContent = seconds < 5 ? 'Updated just now' : `Updated ${seconds} sec ago`;
}

setInterval(() => {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('en-US', { hour12: false });
  updateSyncAge();
}, 1000);

for (const id of ['case-search', 'severity-filter', 'category-filter', 'sort-filter']) {
  document.getElementById(id).addEventListener(id === 'case-search' ? 'input' : 'change', renderQueue);
}
for (const tab of document.querySelectorAll('.queue__tab')) {
  tab.addEventListener('click', () => {
    activeQueueStatus = tab.dataset.status;
    for (const item of document.querySelectorAll('.queue__tab')) {
      const active = item === tab;
      item.classList.toggle('queue__tab--active', active);
      item.setAttribute('aria-selected', String(active));
    }
    renderQueue();
  });
}

const demoMenuToggle = document.getElementById('demo-menu-toggle');
const demoMenuPanel = document.getElementById('demo-menu-panel');
demoMenuToggle.addEventListener('click', () => {
  const open = demoMenuPanel.hidden;
  demoMenuPanel.hidden = !open;
  demoMenuToggle.setAttribute('aria-expanded', String(open));
});

document.getElementById('btn-call').addEventListener('click', async () => {
  closeBuildingPanel();
  closeCasePanel();
  await startCall();
  poll();
});
document.getElementById('btn-reset').addEventListener('click', async () => {
  demoMenuPanel.hidden = true;
  demoMenuToggle.setAttribute('aria-expanded', 'false');
  await resetDemo();
  resetIntakeUI();
  clearRoute();
  stopPulse();
  chosenWorkerId = null;
  workflowOverrides.clear();
  priorityOverrides.clear();
  duplicateOverrides.clear();
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
