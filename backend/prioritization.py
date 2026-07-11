"""Pure duplicate clustering and priority scoring for labeled cases."""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable

from models import Case, PinColor

CLUSTER_PRECISION = 3  # roughly a 100 metre grid in San Francisco
URGENCY_SCORE = {"low": 20, "medium": 45, "high": 70, "critical": 90}


def cluster_key(case: Case) -> tuple[float, float, str]:
    """Return the stable location/category key shared by every case source."""
    return (
        round(case.lat, CLUSTER_PRECISION),
        round(case.long, CLUSTER_PRECISION),
        case.ai_category,
    )


def score_case(case: Case, duplicate_count: int) -> int:
    """Combine urgency, safety, and report volume into a bounded score."""
    score = URGENCY_SCORE.get(case.ai_urgency, URGENCY_SCORE["low"])
    score += 15 if case.safety_risk else 0
    score += min(max(duplicate_count - 1, 0) * 10, 30)
    return max(0, min(100, score))


def pin_color(priority_score: int, duplicate_count: int) -> PinColor:
    if duplicate_count >= 3 or priority_score >= 85:
        return "red"
    if duplicate_count == 2 or priority_score >= 60:
        return "orange"
    return "yellow"


def prioritize(cases: Iterable[Case]) -> list[Case]:
    """Return scored copies, leaving caller-owned case objects unchanged."""
    case_list = list(cases)
    counts = Counter(cluster_key(case) for case in case_list)
    prioritized = []
    for case in case_list:
        duplicate_count = counts[cluster_key(case)]
        priority_score = score_case(case, duplicate_count)
        prioritized.append(
            case.model_copy(
                update={
                    "duplicate_count": duplicate_count,
                    "priority_score": priority_score,
                    "pin_color": pin_color(priority_score, duplicate_count),
                }
            )
        )
    return prioritized
