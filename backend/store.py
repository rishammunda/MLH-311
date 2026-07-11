"""Persistent case store with SQLite locally and Postgres in production.

The storage boundary intentionally accepts the frozen ``Case`` model. New case
sources can call ``upsert`` without knowing how clustering or scoring works.
"""
from __future__ import annotations

import os
import sqlite3
import threading
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from models import Case
from prioritization import cluster_key as _cluster_key
from prioritization import pin_color as _pin_color
from prioritization import prioritize
from prioritization import score_case as _score

_COLUMNS = (
    "id",
    "requested_at",
    "raw_category",
    "raw_details",
    "address",
    "neighborhood",
    "lat",
    "long",
    "status",
    "source",
    "ai_category",
    "ai_urgency",
    "ai_summary",
    "safety_risk",
    "priority_score",
    "duplicate_count",
    "pin_color",
)


class CaseStore:
    """SQL-backed store whose public methods are safe to call across threads."""

    def __init__(self, database_url: str | None = None):
        self._lock = threading.RLock()
        postgres_schemes = ("postgres://", "postgresql://")
        self._is_postgres = bool(database_url and database_url.startswith(postgres_schemes))

        if self._is_postgres:
            import psycopg
            from psycopg.rows import dict_row

            self._connection = psycopg.connect(database_url, row_factory=dict_row)
            self._placeholder = "%s"
        else:
            path = self._sqlite_path(database_url)
            self._connection = sqlite3.connect(path, check_same_thread=False)
            self._connection.row_factory = sqlite3.Row
            self._placeholder = "?"

        self._create_schema()

    @staticmethod
    def _sqlite_path(database_url: str | None) -> str:
        if not database_url:
            return str(Path(__file__).with_name("sf311.db"))
        if database_url in {"sqlite://", "sqlite:///:memory:"}:
            return ":memory:"
        if database_url.startswith("sqlite:///"):
            return database_url.removeprefix("sqlite:///")
        raise ValueError("DATABASE_URL must use postgres://, postgresql://, or sqlite:///")

    def _create_schema(self) -> None:
        boolean_type = "BOOLEAN" if self._is_postgres else "INTEGER"
        with self._lock:
            self._connection.execute(
                f"""
                CREATE TABLE IF NOT EXISTS cases (
                    id TEXT PRIMARY KEY,
                    requested_at TEXT NOT NULL,
                    raw_category TEXT,
                    raw_details TEXT,
                    address TEXT,
                    neighborhood TEXT,
                    lat DOUBLE PRECISION NOT NULL,
                    long DOUBLE PRECISION NOT NULL,
                    status TEXT,
                    source TEXT,
                    ai_category TEXT NOT NULL,
                    ai_urgency TEXT NOT NULL,
                    ai_summary TEXT NOT NULL,
                    safety_risk {boolean_type} NOT NULL,
                    priority_score INTEGER NOT NULL,
                    duplicate_count INTEGER NOT NULL,
                    pin_color TEXT NOT NULL
                )
                """
            )
            self._connection.execute(
                "CREATE INDEX IF NOT EXISTS cases_priority_idx ON cases (priority_score DESC)"
            )
            self._connection.commit()

    @staticmethod
    def _values(case: Case) -> tuple[Any, ...]:
        values = case.model_dump()
        return tuple(values[column] for column in _COLUMNS)

    def _write_cases(self, cases: Iterable[Case]) -> None:
        placeholders = ", ".join([self._placeholder] * len(_COLUMNS))
        updates = ", ".join(
            f"{column} = EXCLUDED.{column}" for column in _COLUMNS if column != "id"
        )
        sql = (
            f"INSERT INTO cases ({', '.join(_COLUMNS)}) VALUES ({placeholders}) "
            f"ON CONFLICT (id) DO UPDATE SET {updates}"
        )
        self._connection.executemany(sql, [self._values(case) for case in cases])

    def _all_cases(self) -> list[Case]:
        cursor = self._connection.execute(f"SELECT {', '.join(_COLUMNS)} FROM cases")
        return [Case.model_validate(dict(row)) for row in cursor.fetchall()]

    def upsert(self, case: Case) -> None:
        self.upsert_many([case])

    def upsert_many(self, cases: Iterable[Case]) -> None:
        incoming = list(cases)
        if not incoming:
            return
        with self._lock:
            try:
                self._write_cases(incoming)
                self._write_cases(prioritize(self._all_cases()))
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise

    def get_cases(
        self,
        limit: int = 100,
        category: str | None = None,
        min_priority: int = 0,
    ) -> list[Case]:
        where = [f"priority_score >= {self._placeholder}"]
        params: list[Any] = [min_priority]
        if category is not None:
            where.append(f"ai_category = {self._placeholder}")
            params.append(category)
        params.append(limit)
        sql = (
            f"SELECT {', '.join(_COLUMNS)} FROM cases "
            f"WHERE {' AND '.join(where)} "
            f"ORDER BY priority_score DESC, requested_at DESC LIMIT {self._placeholder}"
        )
        with self._lock:
            cursor = self._connection.execute(sql, params)
            return [Case.model_validate(dict(row)) for row in cursor.fetchall()]

    def get_case(self, case_id: str) -> Case | None:
        sql = f"SELECT {', '.join(_COLUMNS)} FROM cases WHERE id = {self._placeholder}"
        with self._lock:
            row = self._connection.execute(sql, (case_id,)).fetchone()
            return Case.model_validate(dict(row)) if row else None

    def delete_case(self, case_id: str) -> None:
        with self._lock:
            try:
                self._connection.execute(
                    f"DELETE FROM cases WHERE id = {self._placeholder}", (case_id,)
                )
                self._write_cases(prioritize(self._all_cases()))
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise

    def count(self) -> int:
        with self._lock:
            row = self._connection.execute("SELECT COUNT(*) AS total FROM cases").fetchone()
            return int(row["total"] if isinstance(row, dict) else row[0])

    def close(self) -> None:
        with self._lock:
            self._connection.close()


_store = CaseStore(os.getenv("DATABASE_URL"))


def upsert(case: Case) -> None:
    _store.upsert(case)


def upsert_many(cases: Iterable[Case]) -> None:
    _store.upsert_many(cases)


def get_cases(
    limit: int = 100,
    category: str | None = None,
    min_priority: int = 0,
) -> list[Case]:
    return _store.get_cases(limit, category, min_priority)


def get_case(case_id: str) -> Case | None:
    return _store.get_case(case_id)


def delete_case(case_id: str) -> None:
    _store.delete_case(case_id)


def count() -> int:
    return _store.count()
