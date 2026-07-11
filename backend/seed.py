"""Load the frozen SF311 snapshot into the store for demo mode.

Demo mode never touches the network: the dashboard is populated from
``data/seed_cases.json`` (built once by ``scripts/build_seed.py``), then the
scripted call in ``demo.py`` adds the one live case on top.
"""
from __future__ import annotations

import json
from pathlib import Path

import store
from models import Case

SEED_PATH = Path(__file__).with_name("data") / "seed_cases.json"


def load_seed() -> int:
    raw = json.loads(SEED_PATH.read_text())
    cases = [Case.model_validate(r) for r in raw]
    store.upsert_many(cases)
    return len(cases)
