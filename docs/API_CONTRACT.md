# API Contract

This is the frozen interface between backend and frontend. Build to this from hour 0 so both
sides can work in parallel. If it must change, ping the team first.

Base URL (local): `http://localhost:8000`
Base URL (prod): set by DO deploy, e.g. `https://sf311-triage-xxxxx.ondigitalocean.app`

**All data routes are under an `/api` prefix** (so they match the DigitalOcean route).
So the endpoints below are `GET /api/cases`, `GET /api/health`, etc. `GET /health` also
exists at the root for the platform health probe. On the frontend, set
`VITE_API_BASE` to the base + `/api` and call `${VITE_API_BASE}/cases`.

All responses are JSON. The public API is **read-only** (server → client only).

---

## `GET /api/health` (also `GET /health`)

Liveness check.

```json
{ "status": "ok", "cases": 0 }
```

---

## `GET /api/cases`

Returns the current set of labeled cases, already prioritized.

**Query params (all optional):**

| param | type | default | meaning |
| --- | --- | --- | --- |
| `limit` | int | 100 | max cases to return |
| `category` | string | — | filter by AI category |
| `min_priority` | int | 0 | only cases with priority_score ≥ this |

**Response:**

```json
{
  "count": 2,
  "cases": [
    {
      "id": "19283746",
      "requested_at": "2026-07-11T04:12:00Z",
      "raw_category": "Street and Sidewalk Cleaning",
      "raw_details": "Large pothole at intersection, cars swerving",
      "address": "Market St & 5th St",
      "neighborhood": "Financial District",
      "lat": 37.7841,
      "long": -122.4076,
      "status": "Open",
      "source": "Mobile/Open311",

      "ai_category": "pothole",
      "ai_urgency": "high",
      "ai_summary": "Large pothole causing cars to swerve at a busy intersection",
      "safety_risk": true,

      "priority_score": 88,
      "duplicate_count": 3,
      "pin_color": "red"
    }
  ]
}
```

### Field guarantees for the frontend

- `lat` / `long` are always numbers (cases missing coordinates are dropped by the backend).
- `pin_color` is always one of `"red" | "orange" | "yellow"`. Map it directly to marker color.
  - `red` — 3+ clustered reports (high urgency, act first)
  - `orange` — 2 reports or high single-report priority
  - `yellow` — single, lower priority
- `priority_score` is `0–100`; the ranked queue sorts by this **descending**.
- `ai_category` is one of:
  `pothole | streetlight | graffiti | illegal_dumping | water_leak | encampment | other`.
- `ai_urgency` is one of: `low | medium | high | critical`.
- `duplicate_count` ≥ 1 (1 = no duplicates).

---

## `GET /api/stream` (stretch — SSE)

Server-Sent Events stream that pushes new/updated cases as they're labeled, so the map
updates without a refresh. Each event `data:` is a single case object (same shape as an entry
in `/cases`).

```
event: case
data: { ...case object... }
```

Frontend can start with polling `GET /cases` every ~5s and upgrade to SSE if time allows.

---

## `POST /api/simulate/surge` (demo helper, optional)

Injects N duplicate reports at a location to demonstrate red escalation live during the demo.
Not part of the public product; guard behind a flag / disable in prod.

```json
// request
{ "case_id": "19283746", "count": 3 }
// response
{ "ok": true, "new_pin_color": "red", "priority_score": 92 }
```

---

## Errors

Standard HTTP codes. Rate-limited requests return `429`:

```json
{ "detail": "Rate limit exceeded. Try again later." }
```

## Mock data for the frontend

Until the backend is live, hit this same shape from `frontend/src/mockCases.json` (backend
owner will commit a realistic mock file early so the frontend is never blocked).
