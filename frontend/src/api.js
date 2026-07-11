// Thin client for the FastAPI backend. Everything polls — no push
// infrastructure, which is exactly what makes the demo bulletproof.

async function json(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export const fetchCases = (limit = 500) => json(`/api/cases?limit=${limit}`);
export const fetchDemoState = () => json('/api/demo/state');
export const startCall = () => json('/api/demo/call/start', { method: 'POST' });
export const acceptTask = () => json('/api/demo/accept', { method: 'POST' });
export const resetDemo = () => json('/api/demo/reset', { method: 'POST' });

export const CATEGORY_LABELS = {
  pothole: 'Pothole',
  streetlight: 'Streetlight',
  graffiti: 'Graffiti',
  illegal_dumping: 'Illegal dumping',
  water_leak: 'Water / sewer',
  encampment: 'Encampment',
  other: 'General'
};

// Validated dark-surface status palette (see dataviz reference).
export const PIN_COLORS = { red: '#d03b3b', orange: '#ec835a', yellow: '#fab219' };
export const GOOD = '#0ca30c';
export const ACCENT = '#3987e5';

export function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
