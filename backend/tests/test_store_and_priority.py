import os
import tempfile
import unittest
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from models import Case
from prioritization import prioritize, score_case
from store import CaseStore


def make_case(case_id: str, **changes) -> Case:
    values = {
        "id": case_id,
        "requested_at": "2026-07-11T04:12:00Z",
        "lat": 37.7841,
        "long": -122.4076,
        "ai_category": "pothole",
        "ai_urgency": "low",
        "ai_summary": "Pothole",
        "safety_risk": False,
    }
    values.update(changes)
    return Case(**values)


class PriorityTests(unittest.TestCase):
    def test_scoring_is_bounded_and_combines_all_inputs(self):
        risky = make_case("risky", ai_urgency="high", safety_risk=True)
        self.assertEqual(score_case(risky, 1), 85)
        self.assertEqual(score_case(risky, 4), 100)

    def test_clustering_uses_rounded_location_and_category(self):
        cases = prioritize(
            [
                make_case("a"),
                make_case("b", lat=37.7842, long=-122.4077),
                make_case("c", ai_category="graffiti"),
            ]
        )
        by_id = {case.id: case for case in cases}
        self.assertEqual(by_id["a"].duplicate_count, 2)
        self.assertEqual(by_id["a"].pin_color, "orange")
        self.assertEqual(by_id["c"].duplicate_count, 1)


class StoreTests(unittest.TestCase):
    def test_sqlite_persists_and_filters_parameterized_values(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "cases.db"
            url = f"sqlite:///{database}"
            store = CaseStore(url)
            store.upsert_many(
                [
                    make_case("first", ai_urgency="critical"),
                    make_case("quoted", ai_category="other", raw_details="it's safe; DROP TABLE cases"),
                ]
            )
            store.close()

            reopened = CaseStore(url)
            self.assertEqual(reopened.count(), 2)
            self.assertEqual(reopened.get_cases(category="other")[0].id, "quoted")
            self.assertEqual(reopened.get_cases(min_priority=90)[0].id, "first")
            reopened.close()


if __name__ == "__main__":
    unittest.main()
