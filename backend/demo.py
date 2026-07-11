"""Scripted demo flow: mock resident call -> AI triage -> map pin -> crew match.

Everything here is deterministic and driven by wall-clock offsets from the
moment the call starts, so the dashboard and the worker phone can both poll
``GET /api/demo/state`` and stay perfectly in sync with zero push
infrastructure.

The "AI extraction" step shells out to ``codex exec`` in a background thread
(no API key needed). If codex is slow, missing, or returns junk, the scripted
fallback fields are used instead — the demo never stalls on the model.
"""
from __future__ import annotations

import json
import math
import re
import subprocess
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

import store
from models import Case

router = APIRouter()

# ---------------------------------------------------------------------------
# The scripted pothole call
# ---------------------------------------------------------------------------

DEMO_CASE_ID = "demo-call-2481"

# Valencia St & 21st St, Mission District.
DEMO_LAT, DEMO_LONG = 37.75665, -122.42127

TRANSCRIPT: list[dict[str, Any]] = [
    {"t": 1.5, "speaker": "agent", "text": "SF311, this line is recorded. What would you like to report?"},
    {"t": 4.5, "speaker": "caller", "text": "Hi — there's a huge pothole on Valencia Street, right at the 21st Street intersection."},
    {"t": 9.0, "speaker": "agent", "text": "I can file that. Can you describe the hazard for the crew?"},
    {"t": 12.5, "speaker": "caller", "text": "It's about two feet wide and deep. Cars keep swerving around it, and a cyclist almost got clipped a minute ago."},
    {"t": 18.0, "speaker": "agent", "text": "Understood. Is it in the traffic lane or the bike lane?"},
    {"t": 20.5, "speaker": "caller", "text": "It's right in the northbound bike lane. Somebody's going to get hurt."},
    {"t": 24.0, "speaker": "agent", "text": "Thank you — filing this now. Crews in the area are being notified."},
]

CALL_END = 26.0          # transcript done, AI takes over
EXTRACTION_REVEALS = {   # when each extracted field appears on screen
    "category": 26.8,
    "urgency": 27.7,
    "location": 28.6,
    "summary": 29.6,
}
CASE_CREATED_AT = 31.0   # pin drops on the map
RECOMMENDED_AT = 34.5    # crew match lands (matching animation in between)

FALLBACK_EXTRACTION = {
    "category": "pothole",
    "urgency": "high",
    "location": "Valencia St & 21st St, Mission",
    "summary": "Large pothole in the northbound bike lane; vehicles swerving and a near-miss with a cyclist reported.",
}

# ---------------------------------------------------------------------------
# Mock field crews
# ---------------------------------------------------------------------------

WORKERS: list[dict[str, Any]] = [
    {"id": "w1", "name": "Marcus Rivera", "role": "Street Repair · Crew 3", "avatar": "MR",
     "vehicle": "Truck PW-214", "skills": ["pothole", "other"], "lat": 37.7519, "long": -122.4180,
     "status": "available"},
    {"id": "w2", "name": "Dana Chen", "role": "Streetlight Electrical", "avatar": "DC",
     "vehicle": "Van EL-072", "skills": ["streetlight"], "lat": 37.7793, "long": -122.4193,
     "status": "available"},
    {"id": "w3", "name": "Luis Ortega", "role": "Environmental Services", "avatar": "LO",
     "vehicle": "Truck ES-118", "skills": ["illegal_dumping", "graffiti"], "lat": 37.7691, "long": -122.4449,
     "status": "on_job"},
    {"id": "w4", "name": "Priya Nair", "role": "Water & Sewer", "avatar": "PN",
     "vehicle": "Truck WS-041", "skills": ["water_leak"], "lat": 37.7946, "long": -122.3999,
     "status": "available"},
    {"id": "w5", "name": "Sam Whitfield", "role": "Graffiti Abatement", "avatar": "SW",
     "vehicle": "Van GA-023", "skills": ["graffiti"], "lat": 37.7609, "long": -122.4350,
     "status": "available"},
    {"id": "w6", "name": "Alicia Gomez", "role": "Outreach Team", "avatar": "AG",
     "vehicle": "Van OT-009", "skills": ["encampment", "other"], "lat": 37.7841, "long": -122.4146,
     "status": "on_job"},
    {"id": "w7", "name": "Ken Park", "role": "Street Repair · Crew 5", "avatar": "KP",
     "vehicle": "Truck PW-231", "skills": ["pothole", "other"], "lat": 37.8019, "long": -122.4368,
     "status": "available"},
]

# ---------------------------------------------------------------------------
# Demo state (single scripted call at a time — this is a stage prop)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_state: dict[str, Any] = {
    "started_at": None,     # float epoch seconds, None = idle
    "case_created": False,
    "accepted_at": None,
    "codex_extraction": None,  # dict once the codex thread returns
}


def _now() -> float:
    return time.time()


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _extraction_fields() -> dict[str, str]:
    """Codex result if it arrived and looks sane, else the scripted values."""
    codex = _state.get("codex_extraction")
    fields = dict(FALLBACK_EXTRACTION)
    if isinstance(codex, dict):
        if codex.get("urgency") in ("high", "critical"):
            fields["urgency"] = codex["urgency"]
        summary = str(codex.get("summary") or "").strip()
        if 20 <= len(summary) <= 220:
            fields["summary"] = summary
    return fields


def _run_codex_extraction() -> None:
    """Ask codex to triage the transcript. Best-effort, deterministic fallback."""
    transcript = "\n".join(f"{ln['speaker'].upper()}: {ln['text']}" for ln in TRANSCRIPT)
    prompt = (
        "You are a 311 triage classifier. Below is a resident call transcript. "
        "Respond with ONLY a JSON object, no prose, shaped exactly like: "
        '{"category": "pothole|streetlight|graffiti|illegal_dumping|water_leak|encampment|other", '
        '"urgency": "low|medium|high|critical", "location": "<short place text>", '
        '"summary": "<one sentence, max 25 words>"}\n\n'
        f"TRANSCRIPT:\n{transcript}"
    )
    try:
        result = subprocess.run(
            ["codex", "exec", "--skip-git-repo-check", "-s", "read-only", prompt],
            capture_output=True, text=True, timeout=60,
        )
        # codex echoes the prompt (which contains a JSON template), so parse
        # candidates back-to-front and reject anything that still looks like
        # the template rather than a real answer.
        for match in reversed(re.findall(r"\{[^{}]*\}", result.stdout, re.DOTALL)):
            try:
                parsed = json.loads(match)
            except json.JSONDecodeError:
                continue
            values = " ".join(str(v) for v in parsed.values())
            if "<" in values or "|" in values:
                continue
            with _lock:
                _state["codex_extraction"] = parsed
            print(f"[demo] codex extraction: {parsed}")
            break
        else:
            print(f"[demo] codex gave no usable JSON; using scripted fields")
    except Exception as e:  # demo must never depend on codex succeeding
        print(f"[demo] codex extraction unavailable ({e}); using scripted fields")


def _build_case(fields: dict[str, str]) -> Case:
    return Case(
        id=DEMO_CASE_ID,
        requested_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        raw_category="Street Defect",
        raw_details="Caller: large pothole at Valencia & 21st, cars swerving, near-miss with cyclist",
        address="Valencia St & 21st St",
        neighborhood="Mission",
        lat=DEMO_LAT,
        long=DEMO_LONG,
        status="Open",
        source="Live call (demo)",
        ai_category="pothole",
        ai_urgency=fields["urgency"],  # type: ignore[arg-type]
        ai_summary=fields["summary"],
        safety_risk=True,
    )


def _recommend(case_lat: float, case_long: float, category: str) -> Optional[dict[str, Any]]:
    candidates = [
        w for w in WORKERS if w["status"] == "available" and category in w["skills"]
    ]
    if not candidates:
        return None
    best = min(candidates, key=lambda w: _haversine_km(case_lat, case_long, w["lat"], w["long"]))
    dist = _haversine_km(case_lat, case_long, best["lat"], best["long"])
    eta = max(2, round(dist / 0.4))  # ~24 km/h through city streets
    return {
        "worker_id": best["id"],
        "distance_km": round(dist, 1),
        "eta_min": eta,
        "reasons": [
            f"Closest available crew — {dist:.1f} km away",
            "Certified for street repair",
            f"ETA ≈ {eta} min from {best['vehicle']}",
        ],
    }


def demo_state() -> dict[str, Any]:
    with _lock:
        started = _state["started_at"]
        accepted_at = _state["accepted_at"]

        if started is None:
            phase, elapsed = "idle", 0.0
        else:
            elapsed = _now() - started
            if elapsed < TRANSCRIPT[0]["t"]:
                phase = "ringing"
            elif elapsed < CALL_END:
                phase = "in_call"
            elif elapsed < CASE_CREATED_AT:
                phase = "extracting"
            elif elapsed < RECOMMENDED_AT:
                phase = "matching"
            elif accepted_at is None:
                phase = "recommended"
            else:
                phase = "accepted"

        fields = _extraction_fields()

        # Create the case exactly once, the moment the timeline crosses the mark.
        if started is not None and elapsed >= CASE_CREATED_AT and not _state["case_created"]:
            store.upsert(_build_case(fields))
            _state["case_created"] = True

        lines = (
            [ln for ln in TRANSCRIPT if ln["t"] <= elapsed] if started is not None else []
        )
        revealed = (
            [k for k, t in EXTRACTION_REVEALS.items() if elapsed >= t]
            if started is not None
            else []
        )

        case = store.get_case(DEMO_CASE_ID) if _state["case_created"] else None

        recommendation = None
        if phase in ("recommended", "accepted"):
            rec = _recommend(DEMO_LAT, DEMO_LONG, "pothole")
            if rec:
                recommendation = {
                    **rec,
                    "case_id": DEMO_CASE_ID,
                    "status": "accepted" if phase == "accepted" else "pending",
                }

        workers = [dict(w) for w in WORKERS]
        if phase == "accepted" and recommendation:
            for w in workers:
                if w["id"] == recommendation["worker_id"]:
                    w["status"] = "en_route"

        return {
            "phase": phase,
            "elapsed": round(elapsed, 2),
            "caller": {"name": "Resident (415) 555-0182", "line": "SF311 Voice Intake"},
            "transcript": lines,
            "transcript_done": started is not None and elapsed >= CALL_END,
            "extraction": {
                "revealed": revealed,
                "fields": {k: fields[k] for k in revealed},
                "source": "codex" if _state.get("codex_extraction") else "scripted",
            },
            "case": case.model_dump() if case else None,
            "recommendation": recommendation,
            "workers": workers,
        }


@router.get("/demo/state")
@router.get("/api/demo/state", include_in_schema=False)
async def get_demo_state():
    return demo_state()


@router.post("/demo/call/start")
@router.post("/api/demo/call/start", include_in_schema=False)
async def start_call():
    with _lock:
        started = _state["started_at"]
        if started is not None and _state["accepted_at"] is None and _now() - started < RECOMMENDED_AT:
            return {"ok": True, "note": "call already in progress"}
        _reset_locked()
        _state["started_at"] = _now()
    threading.Thread(target=_run_codex_extraction, daemon=True).start()
    return {"ok": True}


@router.post("/demo/accept")
@router.post("/api/demo/accept", include_in_schema=False)
async def accept_task():
    with _lock:
        if _state["started_at"] is None or not _state["case_created"]:
            raise HTTPException(status_code=409, detail="No task to accept yet")
        if _state["accepted_at"] is None:
            _state["accepted_at"] = _now()
    return {"ok": True}


def _reset_locked() -> None:
    _state["started_at"] = None
    _state["case_created"] = False
    _state["accepted_at"] = None
    _state["codex_extraction"] = None
    try:
        store.delete_case(DEMO_CASE_ID)
    except Exception:
        pass


@router.post("/demo/reset")
@router.post("/api/demo/reset", include_in_schema=False)
async def reset_demo():
    with _lock:
        _reset_locked()
    return {"ok": True}
