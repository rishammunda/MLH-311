"""In-memory store + clustering + priority scoring.

Kept intentionally simple for the demo. Raghav can swap the dict for DO Managed
Postgres behind the same read/write functions. The public API only ever READS
from here (server -> client only), which is our SQL-injection answer.
"""
from __future__ import annotations

import threading
from collections import defaultdict

from models import Case, PinColor

# case_id -> Case
_cases: dict[str, Case] = {}
_lock = threading.Lock()

# How coarse the duplicate-clustering grid is. ~0.001 deg ≈ 100m in SF.
_CLUSTER_PRECISION = 3

_URGENCY_SCORE = {"low": 20, "medium": 45, "high": 70, "critical": 90}


def _cluster_key(case: Case) -> tuple:
    return (
        round(case.lat, _CLUSTER_PRECISION),
        round(case.long, _CLUSTER_PRECISION),
        case.ai_category,
    )


def _pin_color(priority: int, duplicate_count: int) -> PinColor:
    if duplicate_count >= 3 or priority >= 85:
        return "red"
    if duplicate_count == 2 or priority >= 60:
        return "orange"
    return "yellow"


def _score(case: Case, duplicate_count: int) -> int:
    """Combine AI urgency, safety risk, and duplicate volume into 0-100."""
    base = _URGENCY_SCORE.get(case.ai_urgency, 20)
    if case.safety_risk:
        base += 15
    # Each additional report on the same issue escalates priority.
    base += min((duplicate_count - 1) * 10, 30)
    return max(0, min(100, base))


def _recompute_clusters() -> None:
    """Recompute duplicate_count, priority_score, pin_color across all cases."""
    counts: dict[tuple, int] = defaultdict(int)
    for c in _cases.values():
        counts[_cluster_key(c)] += 1

    for c in _cases.values():
        dup = counts[_cluster_key(c)]
        score = _score(c, dup)
        c.duplicate_count = dup
        c.priority_score = score
        c.pin_color = _pin_color(score, dup)


def upsert(case: Case) -> None:
    """Add or update a labeled case, then recompute clustering/priority."""
    with _lock:
        _cases[case.id] = case
        _recompute_clusters()


def upsert_many(cases: list[Case]) -> None:
    with _lock:
        for case in cases:
            _cases[case.id] = case
        _recompute_clusters()


def get_cases(
    limit: int = 100,
    category: str | None = None,
    min_priority: int = 0,
) -> list[Case]:
    with _lock:
        result = [
            c
            for c in _cases.values()
            if (category is None or c.ai_category == category)
            and c.priority_score >= min_priority
        ]
    result.sort(key=lambda c: c.priority_score, reverse=True)
    return result[:limit]


def get_case(case_id: str) -> Case | None:
    with _lock:
        return _cases.get(case_id)


def count() -> int:
    with _lock:
        return len(_cases)
