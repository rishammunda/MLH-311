"""Tests for the DigitalOcean Gradient AI labeler.

No key or network needed — the OpenAI-compatible client is stubbed.
"""
import os
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

import labeler
from models import Case


def make_case(**changes) -> Case:
    values = {
        "id": "t1",
        "requested_at": "2026-07-11T04:12:00Z",
        "lat": 37.7841,
        "long": -122.4076,
        "raw_category": "Street Defect",
        "raw_details": "huge pothole, cars swerving",
        "ai_category": "other",
        "ai_urgency": "low",
        "ai_summary": "",
        "safety_risk": False,
        "priority_score": 0,
        "duplicate_count": 1,
        "pin_color": "yellow",
    }
    values.update(changes)
    return Case.model_validate(values)


class _FakeMsg:
    def __init__(self, content):
        self.content = content


class _FakeChoice:
    def __init__(self, content):
        self.message = _FakeMsg(content)


class _FakeResp:
    def __init__(self, content):
        self.choices = [_FakeChoice(content)]


def _fake_client(content):
    class _Completions:
        @staticmethod
        def create(**kwargs):
            assert kwargs["model"] == labeler.DO_MODEL
            return _FakeResp(content)

    class _Chat:
        completions = _Completions()

    class _Client:
        chat = _Chat()

    return _Client()


class ExtractJsonTests(unittest.TestCase):
    def test_bare(self):
        self.assertEqual(
            labeler._extract_json('{"ai_category": "pothole"}')["ai_category"], "pothole"
        )

    def test_fenced(self):
        text = '```json\n{"ai_category": "graffiti"}\n```'
        self.assertEqual(labeler._extract_json(text)["ai_category"], "graffiti")

    def test_surrounding_prose(self):
        text = 'Here is the answer:\n{"ai_category": "water_leak"}\nThanks!'
        self.assertEqual(labeler._extract_json(text)["ai_category"], "water_leak")


class LabelCaseTests(unittest.TestCase):
    def setUp(self):
        self._orig = labeler._get_client

    def tearDown(self):
        labeler._get_client = self._orig

    def test_parses_do_response(self):
        payload = (
            '{"ai_category": "pothole", "ai_urgency": "high", '
            '"ai_summary": "big pothole", "safety_risk": true}'
        )
        labeler._get_client = lambda: _fake_client(payload)
        lbl = labeler.label_case(make_case())
        self.assertEqual(lbl.ai_category, "pothole")
        self.assertEqual(lbl.ai_urgency, "high")
        self.assertTrue(lbl.safety_risk)

    def test_falls_back_on_error(self):
        def _boom():
            raise RuntimeError("DO down")

        labeler._get_client = _boom
        lbl = labeler.label_case(make_case(raw_details="something"))
        self.assertEqual(lbl.ai_category, "other")
        self.assertEqual(lbl.ai_urgency, "low")
        self.assertTrue(lbl.ai_summary)  # non-empty from raw text


if __name__ == "__main__":
    unittest.main()
