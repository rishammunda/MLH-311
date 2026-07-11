"""Pull recent 311 cases from SF's SODA API and normalize them into our Case shape."""
from __future__ import annotations

import asyncio
import os
from typing import Optional

import httpx

from models import Case

SODA_URL = "https://data.sfgov.org/resource/vw6y-z8j6.json"

# Retry the SODA fetch a few times with exponential backoff so a single network
# blip or transient 5xx doesn't lose a poll cycle.
_MAX_RETRIES = 3
_BACKOFF_BASE = 1.0  # seconds: 1s, 2s, 4s


def _to_float(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def normalize(raw: dict) -> Optional[Case]:
    """Map one SODA record to our Case. Returns None if it lacks coordinates."""
    lat = _to_float(raw.get("lat"))
    long = _to_float(raw.get("long"))
    # SODA sometimes nests coords under `point`
    if (lat is None or long is None) and isinstance(raw.get("point"), dict):
        coords = raw["point"].get("coordinates")
        if coords and len(coords) == 2:
            long, lat = _to_float(coords[0]), _to_float(coords[1])
    if lat is None or long is None:
        return None

    return Case(
        id=str(raw.get("service_request_id", raw.get(":id", "unknown"))),
        requested_at=raw.get("requested_datetime", ""),
        raw_category=raw.get("service_name") or raw.get("service_subtype"),
        raw_details=raw.get("service_details") or raw.get("service_name"),
        address=raw.get("address"),
        neighborhood=raw.get("neighborhoods_sffind_boundaries")
        or raw.get("analysis_neighborhood"),
        lat=lat,
        long=long,
        status=raw.get("status_description"),
        source=raw.get("source"),
    )


async def fetch_recent(limit: int = 50, open_only: bool = True) -> list[Case]:
    """Fetch the most recent cases from the SODA API, newest first."""
    params = {
        "$order": "requested_datetime DESC",
        "$limit": str(limit),
    }
    if open_only:
        params["$where"] = "status_description='Open'"

    headers = {}
    token = os.getenv("SF_APP_TOKEN")
    if token:
        headers["X-App-Token"] = token

    records = await _fetch_with_retry(params, headers)
    cases = [normalize(r) for r in records]
    return [c for c in cases if c is not None]


async def _fetch_with_retry(params: dict, headers: dict) -> list:
    """GET the SODA endpoint, retrying transient failures with backoff."""
    last_exc: Exception | None = None
    async with httpx.AsyncClient(timeout=30) as client:
        for attempt in range(_MAX_RETRIES):
            try:
                resp = await client.get(SODA_URL, params=params, headers=headers)
                resp.raise_for_status()
                return resp.json()
            except (httpx.HTTPError, httpx.TransportError) as exc:
                last_exc = exc
                if attempt < _MAX_RETRIES - 1:
                    await asyncio.sleep(_BACKOFF_BASE * (2**attempt))
    # Exhausted retries — re-raise so the caller can log and move on.
    raise last_exc  # type: ignore[misc]
