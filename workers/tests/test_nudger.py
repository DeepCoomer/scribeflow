"""Nudger tests (ticket 3.8): run_once with fakes for the db and the email
backend — no live Resend call, per CLAUDE.md."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from scribeflow_workers import db as db_module
from scribeflow_workers import nudger
from scribeflow_workers.config import Settings
from scribeflow_workers.db import NudgeCandidate

NOW = datetime(2026, 7, 20, 12, 0, tzinfo=timezone.utc)


def candidate(
    id_: str,
    owner_user_id: str = "owner-1",
    owner_email: str = "alice@example.com",
    owner_name: str = "Alice",
    meeting_title: str = "Weekly sync",
    text: str = "Send the doc",
    due_date: datetime = NOW - timedelta(days=1),
) -> NudgeCandidate:
    return NudgeCandidate(
        id=id_,
        owner_user_id=owner_user_id,
        owner_email=owner_email,
        owner_name=owner_name,
        meeting_title=meeting_title,
        text=text,
        due_date=due_date,
    )


class FakeEmailBackend:
    def __init__(self, fail_for: set[str] | None = None) -> None:
        self.sent: list[tuple[str, str, str]] = []
        self.fail_for = fail_for or set()

    def send_digest(self, to: str, subject: str, text: str) -> None:
        if to in self.fail_for:
            raise RuntimeError("resend down")
        self.sent.append((to, subject, text))


class DbCalls:
    def __init__(self) -> None:
        self.candidates: list[NudgeCandidate] = []
        self.marked: list[str] = []
        self.marked_when: datetime | None = None


@pytest.fixture()
def db_calls(monkeypatch: pytest.MonkeyPatch) -> DbCalls:
    calls = DbCalls()
    monkeypatch.setattr(
        db_module, "get_nudge_candidates", lambda conn, now, cutoff: calls.candidates
    )

    def fake_mark(conn: Any, ids: list[str], when: datetime) -> None:
        calls.marked.extend(ids)
        calls.marked_when = when

    monkeypatch.setattr(db_module, "mark_nudged", fake_mark)
    return calls


def make_deps(email: Any = None) -> nudger.Deps:
    return nudger.Deps(settings=Settings(), conn=object(), email=email)


def test_skips_entirely_when_no_email_backend_configured(db_calls: DbCalls) -> None:
    db_calls.candidates = [candidate("a1")]
    count = nudger.run_once(make_deps(email=None))
    assert count == 0
    assert db_calls.marked == []


def test_sends_one_digest_per_owner_and_marks_all_their_items_nudged(
    db_calls: DbCalls,
) -> None:
    db_calls.candidates = [
        candidate("a1", owner_user_id="owner-1", owner_email="alice@example.com"),
        candidate("a2", owner_user_id="owner-1", owner_email="alice@example.com"),
        candidate("a3", owner_user_id="owner-2", owner_email="bob@example.com", owner_name="Bob"),
    ]
    email = FakeEmailBackend()
    count = nudger.run_once(make_deps(email=email))

    assert count == 3
    assert {to for to, _, _ in email.sent} == {"alice@example.com", "bob@example.com"}
    alice_text = next(text for to, _, text in email.sent if to == "alice@example.com")
    assert "Send the doc" in alice_text
    assert set(db_calls.marked) == {"a1", "a2", "a3"}


def test_a_failed_send_is_not_marked_nudged_but_other_owners_still_are(
    db_calls: DbCalls,
) -> None:
    db_calls.candidates = [
        candidate("a1", owner_user_id="owner-1", owner_email="alice@example.com"),
        candidate("a2", owner_user_id="owner-2", owner_email="bob@example.com", owner_name="Bob"),
    ]
    email = FakeEmailBackend(fail_for={"alice@example.com"})
    count = nudger.run_once(make_deps(email=email))

    assert count == 1
    assert db_calls.marked == ["a2"]


def test_no_candidates_sends_nothing(db_calls: DbCalls) -> None:
    email = FakeEmailBackend()
    count = nudger.run_once(make_deps(email=email))
    assert count == 0
    assert email.sent == []
    assert db_calls.marked == []
