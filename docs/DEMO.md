# Demo guide — SF311 Live Triage

Everything runs locally, deterministically, with no API keys or live data feeds.
The dashboard is populated from a frozen snapshot of **396 real SF311 cases**
(`backend/data/seed_cases.json`), and the "incoming call" is a scripted state machine
on the backend, so the demo behaves identically every run.

## Run it

```bash
./demo.sh
```

or manually, in two terminals:

```bash
# terminal 1 — backend (demo mode)
cd backend
DEMO_MODE=1 DISABLE_POLLER=1 DATABASE_URL="sqlite:///:memory:" \
  python3 -m uvicorn main:app --port 8000

# terminal 2 — frontend
cd frontend
npm install        # first time only
npm run dev
```

| URL | What it is |
| --- | --- |
| http://localhost:5173 | Operations dashboard (3D map, queue, live intake) |
| http://localhost:5173/worker.html | Worker phone (Marcus Rivera's device) |
| http://localhost:8000/docs | Backend API docs |

To show the phone on a real phone, open `http://<your-mac-ip>:5173/worker.html`
on the same Wi-Fi (add `--host` to `npm run dev` / edit `vite.config.js` `server.host: true`).

## The two-minute script

| Time | Beat | What to do |
| --- | --- | --- |
| 0:00–0:45 | **The problem + the city** | Talk over the idle dashboard: 396 real 311 reports, AI-ranked queue on the left, red = clustered/critical, crew chips are field workers. The camera slowly orbits on its own. |
| 0:45–1:05 | **The call** | Click **☎ Simulate incoming call**. The Live Intake panel slides in; a resident reports a pothole at Valencia & 21st. Transcript streams in like a live call. |
| 1:05–1:25 | **AI triage → map pin** | The AI Triage card extracts category / urgency / location / summary (via `codex exec`, scripted fallback), then the camera flies to the Mission as the new red pin drops with a pulse. It also enters the queue at #3 with a LIVE CALL tag. |
| 1:25–1:45 | **Crew match** | The system scans nearby crews and recommends **Marcus Rivera** — closest available street-repair crew, 0.6 km, 2-min ETA — and draws a dispatch line from his truck to the pothole. |
| 1:45–2:00 | **Acceptance** | On the worker phone, the task card has appeared. Tap **Accept task** — the dashboard line turns green instantly, the queue item flips to CREW EN ROUTE, and a toast confirms. |

Click **Reset** to rewind everything (removes the demo case, phone returns to standby).

## Timeline internals (for rehearsal)

The scripted call is driven by wall-clock offsets from `POST /api/demo/call/start`
(see `backend/demo.py`):

- `0–26s` — transcript lines reveal
- `~27–30s` — extraction fields appear one by one
- `31s` — case is inserted into the store (clustering/priority scoring apply) and the pin drops
- `34.5s` — crew recommendation is issued and the task appears on the worker phone
- acceptance is event-driven (whenever the phone taps Accept)

Both pages just poll `GET /api/demo/state` once per second — refreshing either page
mid-demo resumes cleanly.

## Reliability notes

- **No network needed** beyond basemap tiles (CARTO). Buildings, 311 data, workers, and the
  call are all local.
- The AI extraction runs `codex exec` in a background thread with a 60s timeout; if codex is
  missing/slow/wrong, the scripted fields are used and the demo doesn't stall or change shape.
- The 3D city model is a slimmed 40 MB GeoJSON (145k footprints, Douglas-Peucker simplified);
  it loads once behind the boot screen in a few seconds.
