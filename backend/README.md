# Backend — SF311 Live Triage API

FastAPI service that ingests live SF 311 cases, AI-labels them with Claude, and
serves them via a rate-limited, read-only API. See [../docs/API_CONTRACT.md](../docs/API_CONTRACT.md).

## Run locally

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # then add your ANTHROPIC_API_KEY
uvicorn main:app --reload --port 8000
```

Then:
- Health: http://localhost:8000/health
- Cases: http://localhost:8000/cases
- Interactive docs: http://localhost:8000/docs

## Layout

| File | What |
| --- | --- |
| `main.py` | FastAPI app, routes, rate limiting, background poller |
| `ingest.py` | Pulls + normalizes cases from the SF SODA API |
| `labeler.py` | Claude (`claude-haiku-4-5`) → strict JSON label per case |
| `store.py` | SQLite/Postgres persistence through one parameterized store API |
| `prioritization.py` | Source-independent duplicate clustering + priority scoring |
| `models.py` | Shared Pydantic models (the frozen case shape) |

## Storage and demo surge

With no `DATABASE_URL`, cases persist to `backend/sf311.db`. Set a PostgreSQL URL
to use Postgres instead; DigitalOcean injects this automatically in production.

The optional surge helper is hidden unless explicitly enabled:

```bash
ENABLE_SIMULATE_SURGE=1 uvicorn main:app --reload --port 8000
curl -X POST http://localhost:8000/simulate/surge \
  -H 'Content-Type: application/json' \
  -d '{"case_id":"19283746","count":3}'
```

## Verification

Run the three focused storage/clustering/scoring tests:

```bash
cd backend
.venv/bin/python -m unittest discover -s tests -v
```

Then manually check `/health`, `/cases`, filters, and (when enabled)
`/simulate/surge`. DigitalOcean exposes the same API under `/api`.

## Notes

- **Extensible data flow**: ingest and future mock-call sources write the same frozen
  `Case` model. Worker assignment and notifications can read prioritized cases without
  changing the clustering function.
- **Rate limiting**: `/cases` is capped per-IP (SlowAPI) to blunt injection/abuse.
- **Untrusted input**: report text is passed to the LLM as delimited data, never as
  instructions; the model output is validated against a strict JSON schema.
- **Demo resilience**: if the Anthropic API is unavailable, `labeler.py` falls back to a
  safe default label so a case is never dropped.
