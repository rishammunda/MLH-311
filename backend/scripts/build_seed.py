"""Build backend/data/seed_cases.json from a one-time SODA snapshot.

The demo intentionally runs from a frozen snapshot of real SF311 data so it is
fast and reliable with no network or API keys. Labeling here is deterministic
(keyword rules), so every run of this script produces the same file.

Usage:
    python scripts/build_seed.py <raw_soda_snapshot.json>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest import normalize  # noqa: E402
from models import AILabel, Case  # noqa: E402
from labeler import apply_label  # noqa: E402

# (category, urgency, safety_risk) chosen per raw service_name/subtype keywords.
RULES: list[tuple[tuple[str, ...], str, str, bool]] = [
    (("pothole", "pavement_defect", "street defect"), "pothole", "high", True),
    (("streetlight", "street_light", "light"), "streetlight", "medium", True),
    (("graffiti",), "graffiti", "low", False),
    (
        ("garbage", "debris", "dumping", "litter", "cleaning", "toter"),
        "illegal_dumping",
        "medium",
        False,
    ),
    (("sewer", "water", "leak", "flood", "catch_basin", "hydrant"), "water_leak", "high", True),
    (("encampment", "homeless"), "encampment", "medium", False),
]

SUMMARY_TEMPLATES = {
    "pothole": "Pavement defect reported{place} — roadway hazard for vehicles and bikes",
    "streetlight": "Streetlight outage reported{place} — block dark at night",
    "graffiti": "Graffiti reported{place} — abatement requested",
    "illegal_dumping": "Garbage and debris dumped{place} — pickup requested",
    "water_leak": "Water/sewer issue reported{place} — possible leak or blocked drain",
    "encampment": "Encampment reported{place} — outreach team requested",
    "other": "{raw} reported{place}",
}

URGENCY_BUMPS = ("blocking", "hazard", "danger", "unsafe", "injur", "swerv", "flood")


def classify(raw: dict) -> AILabel:
    text = " ".join(
        str(raw.get(k) or "")
        for k in ("service_name", "service_subtype", "service_details")
    ).lower()

    category, urgency, safety = "other", "low", False
    for keywords, cat, urg, risk in RULES:
        if any(k in text for k in keywords):
            category, urgency, safety = cat, urg, risk
            break

    if any(k in text for k in URGENCY_BUMPS) and urgency in ("low", "medium"):
        urgency = "high"

    street = str(raw.get("street") or "").title()
    hood = raw.get("neighborhoods_sffind_boundaries") or raw.get("analysis_neighborhood")
    place = ""
    if street and hood:
        place = f" on {street} ({hood})"
    elif street:
        place = f" on {street}"
    elif hood:
        place = f" in {hood}"

    raw_name = str(raw.get("service_name") or "Issue")
    summary = SUMMARY_TEMPLATES[category].format(place=place, raw=raw_name)
    return AILabel(
        ai_category=category, ai_urgency=urgency, ai_summary=summary, safety_risk=safety
    )


def main(snapshot_path: str) -> None:
    records = json.loads(Path(snapshot_path).read_text())
    cases: list[Case] = []
    seen: set[str] = set()
    for raw in records:
        case = normalize(raw)
        if case is None or case.id in seen:
            continue
        seen.add(case.id)
        cases.append(apply_label(case, classify(raw)))

    out = Path(__file__).resolve().parents[1] / "data" / "seed_cases.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps([c.model_dump() for c in cases], indent=1))
    print(f"wrote {len(cases)} cases -> {out}")


if __name__ == "__main__":
    main(sys.argv[1])
