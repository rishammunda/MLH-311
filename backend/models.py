"""Shared data models — the frozen case shape from docs/API_CONTRACT.md."""
from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel

AICategory = Literal[
    "pothole",
    "streetlight",
    "graffiti",
    "illegal_dumping",
    "water_leak",
    "encampment",
    "other",
]
Urgency = Literal["low", "medium", "high", "critical"]
PinColor = Literal["red", "orange", "yellow"]


class AILabel(BaseModel):
    """Exactly what the LLM returns for one case. Validated against this schema."""
    ai_category: AICategory
    ai_urgency: Urgency
    ai_summary: str
    safety_risk: bool


class Case(BaseModel):
    """A fully labeled, prioritized case as served by GET /cases."""
    id: str
    requested_at: str
    raw_category: Optional[str] = None
    raw_details: Optional[str] = None
    address: Optional[str] = None
    neighborhood: Optional[str] = None
    lat: float
    long: float
    status: Optional[str] = None
    source: Optional[str] = None

    # AI-produced
    ai_category: AICategory = "other"
    ai_urgency: Urgency = "low"
    ai_summary: str = ""
    safety_risk: bool = False

    # priority / clustering
    priority_score: int = 0
    duplicate_count: int = 1
    pin_color: PinColor = "yellow"


class CasesResponse(BaseModel):
    count: int
    cases: list[Case]


class SurgeRequest(BaseModel):
    """Demo helper: inject `count` duplicate reports at an existing case."""
    case_id: str
    count: int = 3


class SurgeResponse(BaseModel):
    ok: bool
    new_pin_color: PinColor
    priority_score: int
    duplicate_count: int
