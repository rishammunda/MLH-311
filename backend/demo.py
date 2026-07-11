"""Scripted demo flow: mock resident call -> AI triage -> map pin -> crew match.

Everything here is deterministic and driven by wall-clock offsets from the
moment the call starts, so the dashboard and the worker phone can both poll
``GET /api/demo/state`` and stay perfectly in sync with zero push
infrastructure.

The "AI extraction" step calls DigitalOcean's Gradient AI serverless inference
(OpenAI-compatible) in a background thread, kicked off the moment the call
starts so the result is ready by the on-screen reveal. If the model is slow,
the key is missing, or it returns junk, the scripted fallback fields are used
instead — the demo never stalls on the model.
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

import store
from models import Case

router = APIRouter()

# ---------------------------------------------------------------------------
# Scripted calls. Each one is deterministic, but the dashboard can choose a
# scenario so demos do not feel like the same canned conversation every time.
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

DEMO_SCENARIOS: list[dict[str, Any]] = [
    {
        "id": "valencia-pothole", "case_id": DEMO_CASE_ID,
        "label": "Bike-lane pothole", "caller": "Resident (415) 555-0182",
        "lat": DEMO_LAT, "long": DEMO_LONG, "address": "Valencia St & 21st St",
        "neighborhood": "Mission", "raw_category": "Street Defect", "category": "pothole",
        "urgency": "high", "safety_risk": True,
        "summary": FALLBACK_EXTRACTION["summary"],
        "raw_details": "Large pothole in the bike lane; cars swerving and a cyclist nearly hit.",
        "transcript": TRANSCRIPT,
    },
    {
        "id": "mission-streetlight", "case_id": "demo-call-2482",
        "label": "Dark intersection", "caller": "Maya (415) 555-0114",
        "lat": 37.75242, "long": -122.41818, "address": "Mission St & 24th St",
        "neighborhood": "Mission", "raw_category": "Streetlight", "category": "streetlight",
        "urgency": "high", "safety_risk": True,
        "summary": "Two streetlights are out at a busy crosswalk, leaving pedestrians difficult to see after dark.",
        "raw_details": "Two lights out at the 24th Street crosswalk; near miss involving a child.",
        "transcript": [
            {"t": 1.5, "speaker": "agent", "text": "SF311, what can I help you report today?"},
            {"t": 4.2, "speaker": "caller", "text": "Both streetlights are out at Mission and 24th, right by the BART entrance."},
            {"t": 8.0, "speaker": "agent", "text": "Is the intersection completely dark?"},
            {"t": 11.3, "speaker": "caller", "text": "The crosswalk is. A driver almost missed a child crossing about five minutes ago."},
            {"t": 16.4, "speaker": "agent", "text": "Are the signal lights still operating?"},
            {"t": 19.7, "speaker": "caller", "text": "Yes, the traffic signals work. It is the two tall lamps over the crosswalk."},
            {"t": 24.0, "speaker": "agent", "text": "Thank you. I am marking this for urgent electrical response."},
        ],
    },
    {
        "id": "geary-water", "case_id": "demo-call-2483",
        "label": "Water main leak", "caller": "Business owner (415) 555-0167",
        "lat": 37.78562, "long": -122.42178, "address": "Van Ness Ave & Geary Blvd",
        "neighborhood": "Cathedral Hill", "raw_category": "Sewer Issues", "category": "water_leak",
        "urgency": "critical", "safety_risk": True,
        "summary": "Water is rapidly bubbling through the roadway and flooding the curb lane near a major intersection.",
        "raw_details": "Water pushing up through asphalt and spreading into the Geary curb lane.",
        "transcript": [
            {"t": 1.5, "speaker": "agent", "text": "SF311 emergency intake. Tell me what you are seeing."},
            {"t": 4.1, "speaker": "caller", "text": "Water is bubbling straight through the pavement at Van Ness and Geary."},
            {"t": 8.3, "speaker": "agent", "text": "How quickly is it spreading?"},
            {"t": 11.8, "speaker": "caller", "text": "Fast. The whole curb lane is covered now and the asphalt looks like it is lifting."},
            {"t": 16.8, "speaker": "agent", "text": "Is traffic able to pass safely?"},
            {"t": 20.1, "speaker": "caller", "text": "Cars are moving around it, but someone needs to block this lane immediately."},
            {"t": 24.0, "speaker": "agent", "text": "I have it. Water and traffic crews are being alerted now."},
        ],
    },
    {
        "id": "haight-graffiti", "case_id": "demo-call-2484",
        "label": "Storefront graffiti", "caller": "Shop manager (415) 555-0142",
        "lat": 37.76988, "long": -122.44692, "address": "Haight St & Ashbury St",
        "neighborhood": "Haight-Ashbury", "raw_category": "Graffiti", "category": "graffiti",
        "urgency": "medium", "safety_risk": False,
        "summary": "Fresh graffiti covers a storefront shutter and adjacent wayfinding sign at Haight and Ashbury.",
        "raw_details": "Large fresh tag across store shutter and public wayfinding sign.",
        "transcript": [
            {"t": 1.5, "speaker": "agent", "text": "SF311, what would you like to report?"},
            {"t": 4.4, "speaker": "caller", "text": "Someone tagged our entire storefront shutter overnight at Haight and Ashbury."},
            {"t": 8.5, "speaker": "agent", "text": "Is the graffiti only on private property?"},
            {"t": 12.2, "speaker": "caller", "text": "It also covers the city wayfinding sign beside our door."},
            {"t": 17.0, "speaker": "agent", "text": "Do you see any hateful or threatening language?"},
            {"t": 20.4, "speaker": "caller", "text": "No, it is a large silver tag. It still looks wet."},
            {"t": 24.0, "speaker": "agent", "text": "Thanks. I will send this to graffiti abatement."},
        ],
    },
    {
        "id": "bayview-dumping", "case_id": "demo-call-2485",
        "label": "Illegal dumping", "caller": "Resident (415) 555-0191",
        "lat": 37.73461, "long": -122.39082, "address": "3rd St & Palou Ave",
        "neighborhood": "Bayview", "raw_category": "Illegal Dumping", "category": "illegal_dumping",
        "urgency": "medium", "safety_risk": True,
        "summary": "Mattresses and construction debris block the bike lane and part of the sidewalk near Palou Avenue.",
        "raw_details": "Dumped mattresses, lumber, and broken tile blocking bike lane and sidewalk.",
        "transcript": [
            {"t": 1.5, "speaker": "agent", "text": "SF311, how can I assist?"},
            {"t": 4.0, "speaker": "caller", "text": "A truck dumped mattresses and construction debris at Third and Palou."},
            {"t": 8.2, "speaker": "agent", "text": "Is any travel lane or sidewalk blocked?"},
            {"t": 11.5, "speaker": "caller", "text": "The bike lane is fully blocked and people in wheelchairs cannot use the sidewalk."},
            {"t": 16.7, "speaker": "agent", "text": "Did you see the vehicle or a plate?"},
            {"t": 20.0, "speaker": "caller", "text": "A white pickup, but I could not read the plate. It left toward Evans."},
            {"t": 24.0, "speaker": "agent", "text": "Understood. Environmental services will receive the report."},
        ],
    },
    {
        "id": "bryant-encampment", "case_id": "demo-call-2486",
        "label": "Blocked sidewalk", "caller": "Mobility-aid user (415) 555-0138",
        "lat": 37.76948, "long": -122.41304, "address": "Bryant St & 13th St",
        "neighborhood": "SoMa", "raw_category": "Encampment", "category": "encampment",
        "urgency": "medium", "safety_risk": False,
        "summary": "Tents and belongings leave no accessible path along the sidewalk near the freeway on-ramp.",
        "raw_details": "Sidewalk fully obstructed with no accessible path around tents and belongings.",
        "transcript": [
            {"t": 1.5, "speaker": "agent", "text": "SF311, what issue are you calling about?"},
            {"t": 4.2, "speaker": "caller", "text": "The sidewalk at Bryant and 13th is completely blocked by tents and belongings."},
            {"t": 8.1, "speaker": "agent", "text": "Is there an accessible path around the obstruction?"},
            {"t": 11.7, "speaker": "caller", "text": "No. I use a walker and had to step into the street beside the freeway ramp."},
            {"t": 16.5, "speaker": "agent", "text": "Is anyone in immediate medical danger?"},
            {"t": 19.8, "speaker": "caller", "text": "Not that I can see. We just need a safe path restored."},
            {"t": 24.0, "speaker": "agent", "text": "Thank you. I am routing this to the outreach team."},
        ],
    },
    {
        "id": "embarcadero-signal", "case_id": "demo-call-2487",
        "label": "Damaged curb ramp", "caller": "Visitor (415) 555-0176",
        "lat": 37.79825, "long": -122.39710, "address": "Embarcadero & Broadway",
        "neighborhood": "Waterfront", "raw_category": "Sidewalk Defect", "category": "other",
        "urgency": "high", "safety_risk": True,
        "summary": "A broken curb-ramp plate has created a sharp drop and trip hazard at a crowded waterfront crossing.",
        "raw_details": "Metal curb-ramp plate shifted, exposing a deep gap at the Broadway crossing.",
        "transcript": [
            {"t": 1.5, "speaker": "agent", "text": "SF311, what would you like to report?"},
            {"t": 4.3, "speaker": "caller", "text": "The curb ramp at Embarcadero and Broadway has a metal plate sticking up."},
            {"t": 8.4, "speaker": "agent", "text": "Is it blocking the accessible crossing?"},
            {"t": 11.9, "speaker": "caller", "text": "Yes. There is a deep gap, and an older man just tripped over the edge."},
            {"t": 16.6, "speaker": "agent", "text": "Does he need medical assistance?"},
            {"t": 20.0, "speaker": "caller", "text": "He says he is okay, but the crossing is packed and someone else could fall."},
            {"t": 24.0, "speaker": "agent", "text": "Thank you. I am escalating the sidewalk hazard now."},
        ],
    },
]

SCENARIOS_BY_ID = {scenario["id"]: scenario for scenario in DEMO_SCENARIOS}

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
    "codex_extraction": None,  # dict once the extraction thread returns (DO Gradient AI)
    "scenario_id": DEMO_SCENARIOS[0]["id"],
}


def _now() -> float:
    return time.time()


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _scenario() -> dict[str, Any]:
    return SCENARIOS_BY_ID.get(_state.get("scenario_id"), DEMO_SCENARIOS[0])


def _extraction_fields() -> dict[str, str]:
    """Codex result if it arrived and looks sane, else the scripted values."""
    codex = _state.get("codex_extraction")
    scenario = _scenario()
    fields = {
        "category": scenario["category"],
        "urgency": scenario["urgency"],
        "location": f'{scenario["address"]}, {scenario["neighborhood"]}',
        "summary": scenario["summary"],
    }
    if isinstance(codex, dict):
        if codex.get("urgency") in ("high", "critical"):
            fields["urgency"] = codex["urgency"]
        summary = str(codex.get("summary") or "").strip()
        if 20 <= len(summary) <= 220:
            fields["summary"] = summary
    return fields


# DigitalOcean Gradient AI serverless inference (OpenAI-compatible).
_DO_BASE_URL = os.getenv("DO_INFERENCE_BASE_URL", "https://inference.do-ai.run/v1")
_DO_MODEL = os.getenv("DO_MODEL", "openai-gpt-oss-20b")
_do_client = None


def _get_do_client():
    """Lazily build the OpenAI-compatible client pointed at DigitalOcean.

    Returns None if the SDK isn't installed or no model access key is set, so
    the caller cleanly falls back to the scripted extraction fields.
    """
    global _do_client
    if _do_client is not None:
        return _do_client
    key = os.getenv("DIGITALOCEAN_INFERENCE_KEY")
    if not key:
        return None
    try:
        from openai import OpenAI
    except ImportError:
        return None
    _do_client = OpenAI(base_url=_DO_BASE_URL, api_key=key)
    return _do_client


def _run_extraction(scenario_id: str) -> None:
    """Triage the transcript via DigitalOcean Gradient AI. Best-effort, with a
    deterministic scripted fallback so the demo never stalls on the model."""
    scenario = SCENARIOS_BY_ID.get(scenario_id, DEMO_SCENARIOS[0])
    transcript = "\n".join(f"{ln['speaker'].upper()}: {ln['text']}" for ln in scenario["transcript"])
    prompt = (
        "You are a 311 triage classifier. Below is a resident call transcript. "
        "Respond with ONLY a JSON object, no prose, shaped exactly like: "
        '{"category": "pothole|streetlight|graffiti|illegal_dumping|water_leak|encampment|other", '
        '"urgency": "low|medium|high|critical", "location": "<short place text>", '
        '"summary": "<one sentence, max 25 words>"}\n\n'
        f"TRANSCRIPT:\n{transcript}"
    )

    client = _get_do_client()
    if client is None:
        print("[demo] DO inference key not set; using scripted extraction fields")
        return

    try:
        resp = client.chat.completions.create(
            model=_DO_MODEL,
            max_completion_tokens=256,
            messages=[{"role": "user", "content": prompt}],
        )
        content = resp.choices[0].message.content or ""
        # Parse JSON candidates back-to-front; reject anything that still looks
        # like the template (contains "<" placeholders or "|" option lists).
        for match in reversed(re.findall(r"\{[^{}]*\}", content, re.DOTALL)):
            try:
                parsed = json.loads(match)
            except json.JSONDecodeError:
                continue
            values = " ".join(str(v) for v in parsed.values())
            if "<" in values or "|" in values:
                continue
            with _lock:
                # Guard against a stale thread from a previous/reset call.
                if _state.get("scenario_id") != scenario_id:
                    return
                _state["codex_extraction"] = parsed
            print(f"[demo] DO Gradient AI extraction: {parsed}")
            break
        else:
            print("[demo] DO gave no usable JSON; using scripted fields")
    except Exception as e:  # demo must never depend on the model succeeding
        print(f"[demo] DO extraction unavailable ({e}); using scripted fields")


def _build_case(fields: dict[str, str]) -> Case:
    scenario = _scenario()
    return Case(
        id=scenario["case_id"],
        requested_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        raw_category=scenario["raw_category"],
        raw_details=scenario["raw_details"],
        address=scenario["address"],
        neighborhood=scenario["neighborhood"],
        lat=scenario["lat"],
        long=scenario["long"],
        status="Open",
        source="Live call (demo)",
        ai_category=scenario["category"],
        ai_urgency=fields["urgency"],  # type: ignore[arg-type]
        ai_summary=fields["summary"],
        safety_risk=scenario["safety_risk"],
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
    qualification = {
        "pothole": "Certified for street repair",
        "streetlight": "Licensed electrical response crew",
        "water_leak": "Water and sewer response certified",
        "graffiti": "Assigned to graffiti abatement",
        "illegal_dumping": "Equipped for debris removal",
        "encampment": "Trained outreach response team",
        "other": "Qualified for general street response",
    }.get(category, "Qualified for this service request")
    return {
        "worker_id": best["id"],
        "distance_km": round(dist, 1),
        "eta_min": eta,
        "reasons": [
            f"Closest available crew — {dist:.1f} km away",
            qualification,
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

        scenario = _scenario()
        fields = _extraction_fields()

        # Create the case exactly once, the moment the timeline crosses the mark.
        if started is not None and elapsed >= CASE_CREATED_AT and not _state["case_created"]:
            store.upsert(_build_case(fields))
            _state["case_created"] = True

        lines = (
            [ln for ln in scenario["transcript"] if ln["t"] <= elapsed] if started is not None else []
        )
        revealed = (
            [k for k, t in EXTRACTION_REVEALS.items() if elapsed >= t]
            if started is not None
            else []
        )

        case = store.get_case(scenario["case_id"]) if _state["case_created"] else None

        recommendation = None
        if phase in ("recommended", "accepted"):
            rec = _recommend(scenario["lat"], scenario["long"], scenario["category"])
            if rec:
                recommendation = {
                    **rec,
                    "case_id": scenario["case_id"],
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
            "caller": {"name": scenario["caller"], "line": "SF311 Voice Intake"},
            "scenario": {"id": scenario["id"], "label": scenario["label"]},
            "scenarios": [{"id": item["id"], "label": item["label"], "address": item["address"]} for item in DEMO_SCENARIOS],
            "transcript": lines,
            "transcript_done": started is not None and elapsed >= CALL_END,
            "extraction": {
                "revealed": revealed,
                "fields": {k: fields[k] for k in revealed},
                "source": "gradient-ai" if _state.get("codex_extraction") else "scripted",
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
async def start_call(scenario_id: Optional[str] = None):
    with _lock:
        started = _state["started_at"]
        if started is not None and _state["accepted_at"] is None and _now() - started < RECOMMENDED_AT:
            return {"ok": True, "note": "call already in progress"}
        _reset_locked()
        if scenario_id:
            if scenario_id not in SCENARIOS_BY_ID:
                raise HTTPException(status_code=404, detail="Unknown demo scenario")
            _state["scenario_id"] = scenario_id
        _state["started_at"] = _now()
    threading.Thread(
        target=_run_extraction,
        args=(_state["scenario_id"],),
        daemon=True,
    ).start()
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
    _state["scenario_id"] = DEMO_SCENARIOS[0]["id"]
    try:
        for scenario in DEMO_SCENARIOS:
            store.delete_case(scenario["case_id"])
    except Exception:
        pass


@router.post("/demo/reset")
@router.post("/api/demo/reset", include_in_schema=False)
async def reset_demo():
    with _lock:
        _reset_locked()
    return {"ok": True}
