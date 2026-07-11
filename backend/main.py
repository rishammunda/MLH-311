"""FastAPI app — the rate-limited, read-only public API from docs/API_CONTRACT.md.

Data flow is one-way: SODA API -> ingest -> AI label -> store -> this API -> client.
The public UI never writes to the store, which is our SQL-injection answer.
"""
import asyncio
import os
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import Body, FastAPI, HTTPException, Query, Request
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
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Rate limit exceeded. Try again later."},
    )


async def _ingest_and_label(limit: int = 50) -> int:
    """Pull recent cases, AI-label them, store them. Returns count added."""
    cases = await ingest.fetch_recent(limit=limit)
    labeled = []
    for case in cases:
        # Labeler is sync (Anthropic client); offload so we don't block the loop.
        label = await asyncio.to_thread(label_case, case)
        labeled.append(apply_label(case, label))
    store.upsert_many(labeled)
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


@app.get("/health")
@app.get("/api/health", include_in_schema=False)
async def health():
    return {"status": "ok", "cases": store.count()}


@app.get("/cases", response_model=CasesResponse)
@app.get("/api/cases", response_model=CasesResponse, include_in_schema=False)
@limiter.limit("60/minute")
async def get_cases(
    request: Request,
    limit: int = Query(100, ge=1, le=500),
    category: str | None = None,
    min_priority: int = Query(0, ge=0, le=100),
):
    cases = store.get_cases(limit=limit, category=category, min_priority=min_priority)
    return CasesResponse(count=len(cases), cases=cases)


@app.post("/simulate/surge", response_model=SurgeResponse)
@app.post("/api/simulate/surge", response_model=SurgeResponse, include_in_schema=False)
@limiter.limit("10/minute")
async def simulate_surge(request: Request, surge: SurgeRequest = Body(...)):
    """Add demo-only duplicate reports and return the base case's new priority."""
    if os.getenv("ENABLE_SIMULATE_SURGE") != "1":
        raise HTTPException(status_code=404, detail="Not found")

    base = store.get_case(surge.case_id)
    if base is None:
        raise HTTPException(status_code=404, detail="Case not found")

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    duplicates = [
        base.model_copy(
            update={
                "id": f"{base.id}-surge-{uuid4().hex[:12]}",
                "requested_at": now,
                "raw_details": f"Simulated duplicate of case {base.id}",
                "source": "demo/simulate",
            }
        )
        for _ in range(surge.count)
    ]
    store.upsert_many(duplicates)
    updated = store.get_case(base.id)
    return SurgeResponse(
        ok=True,
        new_pin_color=updated.pin_color,
        priority_score=updated.priority_score,
    )


@app.post("/refresh")
@app.post("/api/refresh", include_in_schema=False)
@limiter.limit("6/minute")
async def refresh(request: Request, limit: int = Query(25, ge=1, le=100)):
    """Manual trigger to pull + label a fresh batch (handy during the demo)."""
    added = await _ingest_and_label(limit=limit)
    return {"ok": True, "added": added, "total": store.count()}
