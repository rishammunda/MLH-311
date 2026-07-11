# Work Split — 3 people, 14 hours

Everyone builds against [API_CONTRACT.md](API_CONTRACT.md) so we work in parallel from hour 0.

---

## 🟦 Shaaz — Backend: Ingest + AI Labeler + API

**Owns:** `backend/`

Tasks:
- [ ] FastAPI app skeleton (`/health`, `/cases`). Rate limiting (SlowAPI or simple middleware).
- [ ] SODA ingest: pull recent cases from `https://data.sfgov.org/resource/vw6y-z8j6.json`.
  Normalize into our case shape. Drop cases without lat/long.
- [ ] AI labeler using Claude (`claude-haiku-4-5`): given raw case text, return strict JSON
  (`category`, `urgency`, `summary`, `safety_risk`). Validate against schema. Batch to control cost.
- [ ] Commit a realistic `frontend/src/mockCases.json` EARLY so Risham is unblocked.
- [ ] `.env.example` with `ANTHROPIC_API_KEY`, `SF_APP_TOKEN` (optional), `DATABASE_URL`.

Hand-off to Raghav: labeled case objects (pre-clustering).

---

## 🟩 Risham — Frontend: Dashboard (repo owner)

**Owns:** `frontend/`

Tasks:
- [ ] React + Vite app. Leaflet map centered on SF (`[37.7749, -122.4194]`, zoom ~12).
- [ ] Fetch `GET /cases`, render a colored pin per case (`pin_color` → marker color).
- [ ] Ranked priority queue panel beside the map, sorted by `priority_score` desc; click a
  row → highlight/zoom its pin.
- [ ] Poll every ~5s (upgrade to SSE `/stream` if time).
- [ ] Category / min-priority filters (stretch).
- [ ] Build against `src/mockCases.json` until backend is live — same shape as `/cases`.
- [ ] Own the GitHub repo: create it, add everyone, protect main, merge PRs.

---

## 🟨 Raghav — Datastore + Clustering/Priority + Deploy

**Owns:** `backend/store` + clustering logic + DigitalOcean deploy config

Tasks:
- [ ] Datastore: DO Managed Postgres (or SQLite/in-memory fallback for the demo).
  Schema for a labeled case. Parameterized queries only.
- [ ] Clustering: group cases by (rounded lat/long + ai_category). Compute `duplicate_count`.
- [ ] Priority scoring: combine `ai_urgency` + `safety_risk` + `duplicate_count` → `0–100`
      and derive `pin_color` (yellow/orange/red thresholds).
- [ ] Deploy to **DigitalOcean App Platform**: backend component + frontend static site +
      Managed Postgres. Set env vars/secrets. Produce the public URL.
- [ ] `POST /simulate/surge` demo helper wiring (with Shaaz).

---

## Shared / hour 0 checklist

- [ ] Risham creates the repo, adds Shaaz + Raghav.
- [ ] Shaaz shares `ANTHROPIC_API_KEY` securely (not committed). Register a free Socrata app
      token for higher SODA limits (optional).
- [ ] Raghav creates the DO project + Managed Postgres early (provisioning takes time).
- [ ] Agree the case shape is FROZEN per the API contract.

## Integration points

1. **Backend ↔ Frontend:** the `/cases` JSON shape. Frozen in the contract.
2. **Labeler ↔ Clustering:** labeled case objects (Shaaz → Raghav) before scoring.
3. **Everything ↔ Deploy:** env vars + build commands (Raghav owns the DO config).
