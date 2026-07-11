import os
import unittest
from unittest import mock

os.environ["DATABASE_URL"] = "sqlite:///:memory:"

import demo
import store


class DemoFlowTests(unittest.TestCase):
    def setUp(self):
        demo._reset_locked()

    def tearDown(self):
        demo._reset_locked()

    def _state_at(self, elapsed: float) -> dict:
        demo._state["started_at"] = 1000.0
        with mock.patch.object(demo, "_now", return_value=1000.0 + elapsed):
            return demo.demo_state()

    def test_idle_before_start(self):
        state = demo.demo_state()
        self.assertEqual(state["phase"], "idle")
        self.assertEqual(state["transcript"], [])
        self.assertIsNone(state["case"])

    def test_transcript_reveals_over_time(self):
        state = self._state_at(13.0)
        self.assertEqual(state["phase"], "in_call")
        self.assertEqual(len(state["transcript"]), 4)
        self.assertEqual(state["extraction"]["revealed"], [])

    def test_extraction_then_case_then_recommendation(self):
        state = self._state_at(29.0)
        self.assertEqual(state["phase"], "extracting")
        self.assertIn("category", state["extraction"]["revealed"])
        self.assertEqual(state["extraction"]["fields"]["category"], "pothole")
        self.assertIsNone(state["case"])

        state = self._state_at(32.0)
        self.assertEqual(state["phase"], "matching")
        self.assertIsNotNone(state["case"])
        self.assertEqual(state["case"]["ai_category"], "pothole")
        self.assertIsNotNone(store.get_case(demo.DEMO_CASE_ID))

        state = self._state_at(40.0)
        self.assertEqual(state["phase"], "recommended")
        rec = state["recommendation"]
        self.assertEqual(rec["worker_id"], "w1")  # Marcus: nearest pothole crew
        self.assertEqual(rec["status"], "pending")

    def test_accept_flips_worker_to_en_route(self):
        self._state_at(40.0)
        demo._state["accepted_at"] = 1041.0
        state = self._state_at(45.0)
        self.assertEqual(state["phase"], "accepted")
        self.assertEqual(state["recommendation"]["status"], "accepted")
        marcus = next(w for w in state["workers"] if w["id"] == "w1")
        self.assertEqual(marcus["status"], "en_route")

    def test_reset_removes_demo_case(self):
        self._state_at(35.0)
        self.assertIsNotNone(store.get_case(demo.DEMO_CASE_ID))
        demo._reset_locked()
        self.assertIsNone(store.get_case(demo.DEMO_CASE_ID))

    def test_codex_junk_never_breaks_fields(self):
        demo._state["codex_extraction"] = {"urgency": "banana", "summary": "x"}
        fields = demo._extraction_fields()
        self.assertEqual(fields["urgency"], "high")
        self.assertEqual(fields["summary"], demo.FALLBACK_EXTRACTION["summary"])

    def test_seven_scenarios_have_distinct_locations_and_conversations(self):
        self.assertEqual(len(demo.DEMO_SCENARIOS), 7)
        self.assertEqual(len({(item["lat"], item["long"]) for item in demo.DEMO_SCENARIOS}), 7)
        self.assertEqual(len({tuple(line["text"] for line in item["transcript"]) for item in demo.DEMO_SCENARIOS}), 7)

    def test_selected_scenario_drives_case_and_recommendation(self):
        demo._state["scenario_id"] = "mission-streetlight"
        state = self._state_at(40.0)
        self.assertEqual(state["case"]["address"], "Mission St & 24th St")
        self.assertEqual(state["case"]["ai_category"], "streetlight")
        self.assertEqual(state["recommendation"]["worker_id"], "w2")


if __name__ == "__main__":
    unittest.main()
