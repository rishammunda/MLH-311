"""FastAPI app — the rate-limited, read-only public API from docs/API_CONTRACT.md.

Data flow is one-way: SODA API -> ingest -> AI label -> store -> this API -> client.
The public UI never writes to the store, which is our SQL-injection answer.
"""
from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

import ingest
import store
from labeler import apply_label, label_case
from models import CasesResponse, SurgeRequest, SurgeResponse

limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="SF311 Live Triage")
app.state.limiter = limiter

# Frontend runs on a different origin (Vite dev server / DO static site).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten to the deployed frontend origin in prod
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Rate limit exceeded. Try again later."},
    )


# Bound how many cases we label concurrently so a big batch doesn't fire dozens
# of Anthropic API calls at once.
_LABEL_CONCURRENCY = int(os.getenv("LABEL_CONCURRENCY", "5"))


async def _ingest_and_label(limit: int = 50) -> int:
    """Pull recent cases, dedupe, AI-label the new ones concurrently, store them.

    Returns the number of NEW cases added (already-seen IDs are skipped so we
    don't re-spend tokens re-labeling cases we already have).
    """
    cases = await ingest.fetch_recent(limit=limit)

    # Dedupe: drop cases already in the store, and any duplicate IDs within this
    # same batch (the SODA feed can repeat an id across overlapping pulls).
    seen = store.known_ids()
    new_cases: list = []
    batch_ids: set[str] = set()
    for case in cases:
        if case.id in seen or case.id in batch_ids:
            continue
        batch_ids.add(case.id)
        new_cases.append(case)

    if not new_cases:
        return 0

    # Label the new cases concurrently, bounded by a semaphore. The labeler is a
    # sync (blocking) call, so each runs in a thread.
    sem = asyncio.Semaphore(_LABEL_CONCURRENCY)

    async def _label(case):
        async with sem:
            label = await asyncio.to_thread(label_case, case)
            return apply_label(case, label)

    labeled = await asyncio.gather(*(_label(c) for c in new_cases))
    store.upsert_many(list(labeled))
    return len(labeled)


@app.on_event("startup")
async def _startup():
    # Seed the dashboard with a first batch so the demo isn't empty on load.
    try:
        await _ingest_and_label(limit=int(os.getenv("SEED_LIMIT", "40")))
    except Exception as e:  # never fail startup on a data-source hiccup
        print(f"[startup] initial ingest failed: {e}")

    # Background poller: keep pulling fresh cases as they arrive.
    async def _poll():
        interval = int(os.getenv("POLL_INTERVAL_SECONDS", "60"))
        while True:
            await asyncio.sleep(interval)
            try:
                added = await _ingest_and_label(limit=25)
                print(f"[poll] labeled {added} cases; total={store.count()}")
            except Exception as e:
                print(f"[poll] error: {e}")

    if os.getenv("DISABLE_POLLER") != "1":
        asyncio.create_task(_poll())


# All data routes live under /api so they match the DigitalOcean App Platform
# route (.do/app.yaml routes the backend component at /api). The frontend's
# VITE_API_BASE points at this same prefix.
api = APIRouter(prefix="/api")


@api.get("/cases", response_model=CasesResponse)
@limiter.limit("60/minute")
async def get_cases(
    request: Request,
    limit: int = Query(100, ge=1, le=500),
    category: str | None = None,
    min_priority: int = Query(0, ge=0, le=100),
):
    cases = store.get_cases(limit=limit, category=category, min_priority=min_priority)
    return CasesResponse(count=len(cases), cases=cases)


@api.post("/refresh")
@limiter.limit("6/minute")
async def refresh(request: Request, limit: int = Query(25, ge=1, le=100)):
    """Manual trigger to pull + label a fresh batch (handy during the demo)."""
    added = await _ingest_and_label(limit=limit)
    return {"ok": True, "added": added, "total": store.count()}


@api.post("/simulate/surge", response_model=SurgeResponse)
async def simulate_surge(body: SurgeRequest):
    """Demo helper: inject duplicate reports at a case to escalate its pin to red.

    Disabled by default. Set ENABLE_SIMULATE=1 to enable (keep it off in prod).
    No rate-limit decorator here: SlowAPI's wrapper conflicts with resolving a
    Pydantic body under `from __future__ import annotations`. This endpoint is
    already gated behind ENABLE_SIMULATE and is demo-only, so the limiter isn't
    needed.
    """
    if os.getenv("ENABLE_SIMULATE") != "1":
        raise HTTPException(status_code=403, detail="Simulation endpoint disabled.")
    count = max(1, min(body.count, 20))
    updated = store.simulate_surge(body.case_id, count)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Case {body.case_id} not found.")
    return SurgeResponse(
        ok=True,
        new_pin_color=updated.pin_color,
        priority_score=updated.priority_score,
        duplicate_count=updated.duplicate_count,
    )


# Health check is exposed both at the root (for DO's platform health probe) and
# under /api (for consistency with the rest of the API).
@app.get("/health")
@api.get("/health")
async def health():
    return {"status": "ok", "cases": store.count()}


app.include_router(api)
