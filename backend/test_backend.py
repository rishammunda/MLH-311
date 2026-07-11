"""Backend tests. Run: cd backend && . .venv/bin/activate && pytest -q

No network or ANTHROPIC_API_KEY needed — the SODA fetch and the Claude labeler
are monkeypatched. Covers dedupe, retry, concurrent labeling, store scoring,
and the API endpoints.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

import ingest
import main
import store
from models import AILabel, Case


def _case(cid: str, lat=37.7749, long=-122.4194, category="Graffiti", details="tag") -> Case:
    return Case(
        id=cid,
        requested_at="2026-07-11T00:00:00Z",
        raw_category=category,
        raw_details=details,
        lat=lat,
        long=long,
    )


@pytest.fixture(autouse=True)
def _clean_store():
    """Reset the in-memory store before each test."""
    store._cases.clear()
    yield
    store._cases.clear()


# ----------------------------- store: scoring / clustering -----------------------------

def test_scoring_low_single_is_yellow():
    store.upsert(
        _case("A").model_copy(update={"ai_category": "graffiti", "ai_urgency": "low"})
    )
    c = store.get_case("A")
    assert c.pin_color == "yellow"
    assert c.priority_score == 20
    assert c.duplicate_count == 1


def test_clustering_escalates_pin_to_red():
    # 3 reports, same rounded location + category -> one cluster of 3 -> red.
    for i in range(3):
        store.upsert(
            _case(f"D{i}").model_copy(
                update={"ai_category": "pothole", "ai_urgency": "high", "safety_risk": True}
            )
        )
    c = store.get_case("D0")
    assert c.duplicate_count == 3
    assert c.pin_color == "red"


def test_different_category_same_location_not_clustered():
    store.upsert(_case("X").model_copy(update={"ai_category": "pothole"}))
    store.upsert(_case("Y").model_copy(update={"ai_category": "graffiti"}))
    assert store.get_case("X").duplicate_count == 1
    assert store.get_case("Y").duplicate_count == 1


def test_get_cases_filters_and_sorts():
    store.upsert(_case("lo").model_copy(update={"ai_urgency": "low", "ai_category": "graffiti"}))
    store.upsert(
        _case("hi", lat=37.7000, long=-122.5000).model_copy(
            update={"ai_urgency": "critical", "ai_category": "water_leak", "safety_risk": True}
        )
    )
    ordered = store.get_cases()
    assert ordered[0].id == "hi"  # highest priority first
    assert store.get_cases(category="graffiti") == [store.get_case("lo")]
    assert all(c.priority_score >= 50 for c in store.get_cases(min_priority=50))


# ----------------------------- store: surge -----------------------------

def test_surge_escalates_and_adds_duplicates():
    store.upsert(_case("S").model_copy(update={"ai_category": "graffiti", "ai_urgency": "low"}))
    updated = store.simulate_surge("S", 3)
    assert updated.duplicate_count == 4
    assert updated.pin_color == "red"
    assert store.count() == 4  # original + 3 synthetic


def test_surge_unknown_case_returns_none():
    assert store.simulate_surge("does-not-exist", 3) is None


# ----------------------------- ingest: dedupe -----------------------------

def _fake_labeler(case: Case) -> AILabel:
    return AILabel(
        ai_category="pothole", ai_urgency="high", ai_summary="s", safety_risk=True
    )


def test_ingest_dedupes_already_seen_ids(monkeypatch):
    labeled_ids: list[str] = []

    def _spy(case: Case) -> AILabel:
        labeled_ids.append(case.id)
        return _fake_labeler(case)

    monkeypatch.setattr(main, "label_case", _spy)

    # First pull returns A, B.
    async def _fetch1(limit=50, open_only=True):
        return [_case("A"), _case("B")]

    monkeypatch.setattr(main.ingest, "fetch_recent", _fetch1)
    added = asyncio.run(main._ingest_and_label(limit=50))
    assert added == 2
    assert set(labeled_ids) == {"A", "B"}

    # Second pull overlaps (A, B, C) — only C is new, only C is labeled.
    labeled_ids.clear()

    async def _fetch2(limit=50, open_only=True):
        return [_case("A"), _case("B"), _case("C")]

    monkeypatch.setattr(main.ingest, "fetch_recent", _fetch2)
    added = asyncio.run(main._ingest_and_label(limit=50))
    assert added == 1
    assert labeled_ids == ["C"]
    assert store.count() == 3


def test_ingest_dedupes_within_a_single_batch(monkeypatch):
    labeled_ids: list[str] = []

    def _spy(case: Case) -> AILabel:
        labeled_ids.append(case.id)
        return _fake_labeler(case)

    monkeypatch.setattr(main, "label_case", _spy)

    async def _fetch(limit=50, open_only=True):
        return [_case("A"), _case("A"), _case("B")]  # duplicate A in one batch

    monkeypatch.setattr(main.ingest, "fetch_recent", _fetch)
    added = asyncio.run(main._ingest_and_label(limit=50))
    assert added == 2
    assert sorted(labeled_ids) == ["A", "B"]


# ----------------------------- ingest: retry -----------------------------

def test_fetch_retries_then_succeeds(monkeypatch):
    calls = {"n": 0}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return [
                {
                    "service_request_id": "R1",
                    "requested_datetime": "2026-07-11T00:00:00Z",
                    "lat": "37.7749",
                    "long": "-122.4194",
                }
            ]

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            calls["n"] += 1
            if calls["n"] < 2:
                raise httpx.ConnectError("boom")
            return _Resp()

    monkeypatch.setattr(ingest.httpx, "AsyncClient", _Client)
    async def _no_sleep(*_a, **_k):
        return None

    monkeypatch.setattr(ingest.asyncio, "sleep", _no_sleep)

    cases = asyncio.run(ingest.fetch_recent(limit=5))
    assert calls["n"] == 2  # failed once, retried, succeeded
    assert len(cases) == 1 and cases[0].id == "R1"


def test_fetch_raises_after_exhausting_retries(monkeypatch):
    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            raise httpx.ConnectError("always down")

    monkeypatch.setattr(ingest.httpx, "AsyncClient", _Client)
    async def _no_sleep(*_a, **_k):
        return None

    monkeypatch.setattr(ingest.asyncio, "sleep", _no_sleep)

    with pytest.raises(httpx.ConnectError):
        asyncio.run(ingest.fetch_recent(limit=5))


# ----------------------------- API endpoints -----------------------------

@pytest.fixture
def client(monkeypatch):
    # Disable poller + startup ingest so tests are hermetic.
    monkeypatch.setenv("DISABLE_POLLER", "1")
    monkeypatch.setenv("SEED_LIMIT", "0")

    async def _no_fetch(limit=50, open_only=True):
        return []

    monkeypatch.setattr(main.ingest, "fetch_recent", _no_fetch)
    with TestClient(main.app) as c:
        yield c


def test_health_endpoints(client):
    assert client.get("/health").status_code == 200
    assert client.get("/api/health").status_code == 200


def test_cases_endpoint(client):
    store.upsert(_case("Z").model_copy(update={"ai_category": "graffiti", "ai_urgency": "low"}))
    r = client.get("/api/cases")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 1
    assert body["cases"][0]["id"] == "Z"
    # old un-prefixed path should not exist
    assert client.get("/cases").status_code == 404


def test_surge_endpoint_disabled_by_default(client, monkeypatch):
    monkeypatch.delenv("ENABLE_SIMULATE", raising=False)
    store.upsert(_case("Q").model_copy(update={"ai_category": "graffiti", "ai_urgency": "low"}))
    r = client.post("/api/simulate/surge", json={"case_id": "Q", "count": 3})
    assert r.status_code == 403


def test_surge_endpoint_enabled(client, monkeypatch):
    monkeypatch.setenv("ENABLE_SIMULATE", "1")
    store.upsert(_case("Q").model_copy(update={"ai_category": "graffiti", "ai_urgency": "low"}))
    r = client.post("/api/simulate/surge", json={"case_id": "Q", "count": 3})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["new_pin_color"] == "red"
    assert body["duplicate_count"] == 4
    # unknown case -> 404
    assert client.post(
        "/api/simulate/surge", json={"case_id": "nope", "count": 3}
    ).status_code == 404
