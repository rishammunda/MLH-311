# Backend — SF311 Live Triage API

FastAPI service that ingests live SF 311 cases, AI-labels them with DigitalOcean
Gradient AI serverless inference, and
serves them via a rate-limited, read-only API. See [../docs/API_CONTRACT.md](../docs/API_CONTRACT.md).

## Run locally

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # then add your DIGITALOCEAN_INFERENCE_KEY
uvicorn main:app --reload --port 8000
```

Then:
- Health: http://localhost:8000/health
- Cases: http://localhost:8000/cases
- Interactive docs: http://localhost:8000/docs

## Tests

```bash
cd backend && source .venv/bin/activate
pytest -q
```

No network or `DIGITALOCEAN_INFERENCE_KEY` needed — the SODA fetch and the labeler are
mocked. Covers dedupe, retry/backoff, concurrent labeling, store clustering/scoring,
surge, and the API endpoints.

## Layout

| File | What |
| --- | --- |
| `main.py` | FastAPI app, routes, rate limiting, background poller |
| `ingest.py` | Pulls + normalizes cases from the SF SODA API |
| `labeler.py` | DigitalOcean Gradient AI (default `openai-gpt-oss-20b`) → JSON label per case |
| `store.py` | In-memory store + clustering + priority scoring (swap for Postgres) |
| `models.py` | Shared Pydantic models (the frozen case shape) |

## Notes

- **One-way data flow**: the public API only reads from the store. The UI never writes.
- **Rate limiting**: `/cases` is capped per-IP (SlowAPI) to blunt injection/abuse.
- **Untrusted input**: report text is passed to the LLM as delimited data, never as
  instructions; the model output is validated against a strict JSON schema.
- **Demo resilience**: if the inference API is unavailable, `labeler.py` falls back to a
  safe default label so a case is never dropped.
