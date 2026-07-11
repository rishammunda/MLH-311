// Shared glyph + marker artwork for the dashboard.
//
// Complaints render as classic teardrop map pins (colored by category, white
// symbol inside). Field crews render as rounded badges with a hard-hat glyph
// and a status dot — a deliberately different silhouette so the two are
// distinguishable at a glance.

export const CATEGORY_COLORS = {
  pothole: '#d85b62',
  streetlight: '#568bd8',
  graffiti: '#8b72c7',
  illegal_dumping: '#c77850',
  water_leak: '#3d91ad',
  encampment: '#4b9b78',
  other: '#718096'
};

// 24×24 stroke glyphs (Lucide-style: round caps, no fill).
const GLYPH_PATHS = {
  // traffic cone
  pothole: '<path d="M10.4 4h3.2l4.9 15h-13z"/><path d="M8.7 10.6h6.6"/><path d="M7.3 14.9h9.4"/><path d="M3.2 19h17.6"/>',
  // lightbulb
  streetlight: '<path d="M15.1 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.4-2.2 1.4-3.5a6 6 0 0 0-12 0c0 1.3.4 2.6 1.4 3.5.8.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 21.5h4"/>',
  // spray can
  graffiti: '<rect x="7.5" y="9" width="7" height="11.5" rx="1.4"/><path d="M9.5 9V6.2h3V9"/><path d="M11 4.2h.01"/><path d="M17.6 5h.01"/><path d="M20 7.6h.01"/><path d="M17.6 10.2h.01"/>',
  // trash bin
  illegal_dumping: '<path d="M3.5 6.5h17"/><path d="M18.5 6.5V19a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6.5"/><path d="M8.5 6.5V4.8a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.7"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  // droplet
  water_leak: '<path d="M12 21.5a6.5 6.5 0 0 0 6.5-6.5c0-1.9-.9-3.6-2.8-5.1-1.8-1.5-3.2-3.7-3.7-6-.5 2.3-1.9 4.5-3.7 6-1.9 1.5-2.8 3.2-2.8 5.1A6.5 6.5 0 0 0 12 21.5z"/>',
  // tent
  encampment: '<path d="M3.5 20.5 14 3.5"/><path d="M20.5 20.5 10 3.5"/><path d="M15.4 20.5 12 14.7l-3.4 5.8"/><path d="M2 20.5h20"/>',
  // report flag
  other: '<path d="M4.5 15s1-1 4-1 5 2 8 2 4-1 4-1V3.5s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4.5 21.5V15"/>'
};

export const HARD_HAT =
  '<path d="M2.5 18.2a1 1 0 0 0 1 1h17a1 1 0 0 0 1-1v-1.7a1 1 0 0 0-1-1h-17a1 1 0 0 0-1 1z"/><path d="M10 14.5V5.8a2 2 0 0 1 4 0v8.7"/><path d="M4.5 14.5v-2a6 6 0 0 1 5.5-6"/><path d="M14 6.5a6 6 0 0 1 5.5 6v2"/>';

export const PHONE =
  '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>';

function strokeGroup(inner, { stroke = '#fff', width = 2 } = {}) {
  return `<g fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
}

/** Small inline glyph for HTML panels (queue rows, legend, chips). */
export function glyphSvg(category, { size = 15, stroke = 'currentColor', width = 2 } = {}) {
  const paths = GLYPH_PATHS[category] || GLYPH_PATHS.other;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${strokeGroup(paths, { stroke, width })}</svg>`;
}

const PIN_SHADOW =
  '<defs><filter id="s" x="-40%" y="-30%" width="180%" height="180%"><feDropShadow dx="0" dy="2.5" stdDeviation="3" flood-color="#04070d" flood-opacity=".55"/></filter></defs>';

/** Teardrop map pin with the category symbol — complaint marker. */
export function casePinSvg(category) {
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
  const paths = GLYPH_PATHS[category] || GLYPH_PATHS.other;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="66" viewBox="0 0 56 66">
  ${PIN_SHADOW}
  <g filter="url(#s)">
    <path d="M28 3.5C16.9 3.5 8 12.4 8 23.5c0 8.3 6.3 17.4 11.7 24.1 2.2 2.8 4.4 5.2 6.1 7 1.2 1.2 3.2 1.2 4.4 0 1.7-1.8 3.9-4.2 6.1-7C41.7 40.9 48 31.8 48 23.5 48 12.4 39.1 3.5 28 3.5z"
      fill="${color}" stroke="#f5f8fd" stroke-width="2.5"/>
    <g transform="translate(16 11.5)">${strokeGroup(paths, { stroke: '#ffffff', width: 2.1 })}</g>
  </g>
</svg>`;
}

/** Rounded crew badge with hard-hat glyph — field-worker marker. */
export function crewBadgeSvg({ busy = false, chosen = false } = {}) {
  const ring = chosen ? '#2fc55f' : '#93a9c9';
  const dot = chosen ? '#2fc55f' : busy ? '#fab219' : '#2fc55f';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="62" viewBox="0 0 56 62">
  ${PIN_SHADOW}
  <g filter="url(#s)">
    <path d="M20.5 41h15L28 55.5z" fill="${ring}"/>
    <rect x="9" y="4.5" width="38" height="38" rx="10" fill="#101b2c" stroke="${ring}" stroke-width="${chosen ? 3.4 : 2.6}"/>
    <g transform="translate(16 11.5)">${strokeGroup(HARD_HAT, { stroke: chosen ? '#a9f0c4' : '#e8eef8', width: 2 })}</g>
    <circle cx="45" cy="8.5" r="5.4" fill="${dot}" stroke="#0a121f" stroke-width="2.2"/>
  </g>
</svg>`;
}
