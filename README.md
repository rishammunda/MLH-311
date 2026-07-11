# SF311 Live Triage

AI-powered, real-time prioritization for San Francisco's 311 infrastructure reports.
As new 311 cases arrive, an LLM live-labels each one (category, urgency, priority) and
places it on a live map + ranked queue so the city knows **where to send crews first**.

> Built for the **DigitalOcean Hackathon** by Shaaz, Risham, and Raghav.

## The pitch

It's the SF311 app that already exists — but made efficient by triaging in real time with AI.
Multiple reports on the same issue escalate the pin from yellow → orange → **red**.

## Repo map

- **[PROJECT.md](PROJECT.md)** — full project spec (problem, solution, architecture, MVP scope).
- **[docs/API_CONTRACT.md](docs/API_CONTRACT.md)** — frozen backend ↔ frontend interface.
- **[docs/WORK_SPLIT.md](docs/WORK_SPLIT.md)** — who owns what (3-person split).
- **[docs/DEPLOY.md](docs/DEPLOY.md)** — DigitalOcean deployment.
- **[backend/](backend/)** — FastAPI ingest + AI labeler + read-only API. See [backend/README.md](backend/README.md).
- **[frontend/](frontend/)** — React + Leaflet dashboard (map + ranked queue).

## Quick start (backend)

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # add ANTHROPIC_API_KEY
uvicorn main:app --reload --port 8000
# → http://localhost:8000/cases
```

Frontend can build against `frontend/src/mockCases.json` (same shape as `/cases`) until
the backend is live.

## Data source

SF **311 Cases** open dataset (`vw6y-z8j6`) via the Socrata SODA API:
`https://data.sfgov.org/resource/vw6y-z8j6.json`
