# SF311 Live Triage — AI-Powered 311 Prioritization Dashboard

> **Digital Ocean Hackathon** · Team: Shaaz, Risham, Raghav · Deadline: 14h
> Repo: https://github.com/rishammunda/MLH-311

---

## 1. The Problem

San Francisco's 311 system receives a firehose of infrastructure reports — potholes, broken
streetlights, illegal dumping, graffiti, encampments, water leaks. Today, humans (or slow
rules engines) triage these reports before the city can act. That triage is:

- **Slow** — reports sit in a queue before anyone classifies or prioritizes them.
- **Expensive** — staff-hours spent reading and routing tickets that a model can label in
  milliseconds.
- **Not prioritized** — a single non-urgent graffiti report and a live water-main leak look
  the same in the raw feed until a human reads them.

The result: the actual high-impact problems — the ones affecting the most people, or posing
safety risks — don't surface fast enough. Time and money are lost in a pre-AI process.

## 2. The Solution

**As 311 data arrives, an LLM live-labels each case and scores its priority — then it lands
on a live map/dashboard the city can act on immediately.**

We take the existing SF311 experience and make it *efficient in real time*:

1. **Ingest** live 311 cases from SF's open dataset (SODA API).
2. **AI-label** each case: category, urgency, a short summary, and a priority score.
3. **De-duplicate & escalate** — when multiple reports cluster on the same issue/location,
   the pin turns **red** (many reports), vs **orange/yellow** (fewer). More voices = higher
   priority.
4. **Visualize** on a live map + ranked queue so the city sees *where to send crews first*.

> Final framing for the demo: "It's the SF311 app that already exists — but we've made it
> efficient by triaging in real time with AI."

## 3. Why It Matters (demo talking points)

- Quantify staff-time and dollars lost to manual triage in legacy municipal processes.
- Modernizes current processes by integrating current technology, building for efficiency as
  calls come in. **Our AI labels the calls coming in as data points that are then placed on
  the map.**
- Actionable insight for municipalities to improve the daily lives of millions of San
  Franciscans.

## 4. Security & Integrity (anticipated judge questions)

| Concern | Our answer |
| --- | --- |
| **Injection via user-submitted report text** | Treat all incoming case text as untrusted data, never as instructions to the LLM. Structured prompt with the report content clearly delimited; validate/normalize the model's JSON output against a strict schema. |
| **Spam / fake reports flooding a location (IP abuse)** | **Rate limiting** per IP on any ingest/submit path. |
| **SQL injection** | **One-way data flow (server → client only)** for the live feed; parameterized queries everywhere; the public UI never writes to the DB. |
| **Duplicate-report gaming** | Clustering by location + category with thresholds so a single actor can't trivially escalate a pin to red. |

## 5. Architecture

```
┌────────────────────┐     poll/stream      ┌──────────────────────┐
│  SF 311 SODA API   │ ───────────────────► │   Ingest Worker      │
│  data.sfgov.org    │                      │  (backend/ingest)    │
└────────────────────┘                      └──────────┬───────────┘
                                                        │ new cases
                                                        ▼
                                            ┌──────────────────────┐
                                            │  AI Labeler (DO      │
                                            │  Gradient AI)        │
                                            │  category, urgency,  │
                                            │  summary, priority   │
                                            └──────────┬───────────┘
                                                        │ labeled cases
                                                        ▼
                                            ┌──────────────────────┐
                                            │  Datastore (Postgres │
                                            │  or in-memory cache) │
                                            └──────────┬───────────┘
                                                        │ server → client only
                                            ┌───────────▼──────────┐
                                            │  API (FastAPI)       │
                                            │  /cases  /stream(SSE)│
                                            │  rate-limited        │
                                            └───────────┬──────────┘
                                                        ▼
                                            ┌──────────────────────┐
                                            │  Frontend Dashboard  │
                                            │  live map + ranked   │
                                            │  queue (React/Vite)  │
                                            └──────────────────────┘
```

### Data flow is deliberately one-way (server → client) for the public dashboard.
The public UI only *reads*. This is our SQL-injection answer and keeps the attack surface small.

## 6. Tech Stack

- **Backend:** Python + **FastAPI** (async, easy SSE for live updates).
- **AI Labeling:** DigitalOcean Gradient AI serverless inference (OpenAI-compatible, default
  model `openai-gpt-oss-20b`). Prompt-and-parse JSON, validated against a strict schema.
  Powers both the live case labeler and the demo call-extraction step.
- **Datastore:** Postgres (managed on DO) — or in-memory/SQLite for the demo fallback.
- **Frontend:** React + Vite + a map library (Leaflet + OpenStreetMap tiles, no API key
  needed). Ranked queue table alongside the map.
- **Deploy:** DigitalOcean App Platform (backend + frontend as components) or a single
  Droplet with Docker Compose. DO Managed Postgres for the DB.

## 7. Data Source — SF 311 Cases

- Dataset: **311 Cases** (`vw6y-z8j6`) on data.sfgov.org
- SODA JSON endpoint: `https://data.sfgov.org/resource/vw6y-z8j6.json`
- Useful fields: `service_request_id`, `requested_datetime`, `updated_datetime`,
  `status_description`, `service_name` / `service_subtype`, `service_details`,
  `address`, `neighborhoods_sffind_boundaries`, `lat`, `long`, `source`, `agency_responsible`.
- Example query (most recent 50, ordered):
  `?$order=requested_datetime DESC&$limit=50`
- SoQL filters (e.g. only open cases):
  `?$where=status_description='Open'&$order=requested_datetime DESC&$limit=50`
- Optional `X-App-Token` header raises rate limits (register a free Socrata app token).

## 8. What the AI Labeler Produces (schema)

For each case, the model returns strict JSON:

```json
{
  "category": "pothole | streetlight | graffiti | illegal_dumping | water_leak | encampment | other",
  "urgency": "low | medium | high | critical",
  "priority_score": 0-100,
  "summary": "one-line human-readable summary",
  "safety_risk": true
}
```

Priority also factors in **duplicate count** at a location (clustered reports escalate the
score and drive the pin color: yellow → orange → red).

## 9. MVP Scope (must-have for the demo)

1. Backend pulls recent 311 cases from the SODA API. ✅ core
2. Each case gets AI-labeled (category, urgency, priority, summary). ✅ core
3. Cases stored + served via a rate-limited, read-only API. ✅ core
4. Frontend shows a **live map** with colored pins + a **ranked priority queue**. ✅ core
5. Duplicate clustering escalates pin color. ⭐ stretch-but-demo-worthy
6. Deployed on DigitalOcean with a public URL. ✅ core (needed to demo)

### Stretch (only if time allows)
- Live SSE push so pins appear without refresh.
- Neighborhood filter + category filter.
- "Simulate a surge" button that injects duplicate reports to show red escalation live.

## 10. Team Split — see [docs/WORK_SPLIT.md](docs/WORK_SPLIT.md)

- **Shaaz** — Backend ingest + AI labeler + API.
- **Risham** — Frontend dashboard (map + ranked queue), repo owner.
- **Raghav** — Datastore + clustering/priority logic + DigitalOcean deployment.

## 11. Milestones (14-hour clock)

| Hour | Target |
| --- | --- |
| 0–2 | Repo + skeleton (this doc), API contract agreed, everyone unblocked, tokens/keys shared. |
| 2–6 | Backend ingest + labeler working against real data; frontend renders mock cases on map. |
| 6–9 | Wire frontend to real API; clustering + priority colors; end-to-end on localhost. |
| 9–12 | Deploy to DigitalOcean; smoke-test public URL; polish UI. |
| 12–14 | Demo script, "simulate surge" moment, rehearse, buffer for breakage. |

See [docs/API_CONTRACT.md](docs/API_CONTRACT.md) for the exact endpoints so frontend and
backend can build in parallel from hour 0.
