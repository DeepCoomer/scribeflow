"""Nudger (ticket 3.8, D66): a daily scan for open, overdue, assigned action
items -> one digest email per owner (optional — see nudge_backends.py). Not
a queue consumer: this is cron-shaped, not message-driven, so it doesn't use
framework.Worker (built around AMQP consuming) — it's a standalone loop that
runs once, sleeps a day, and runs again. The dashboard side of "notifies
owners" (CLAUDE.md/plan.md) needs no code here: the action-items UI already
renders each item's due date from data that already exists, so overdue
styling is a client-side computation, not a nudger write path.

Run: python -m scribeflow_workers.nudger
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from . import db
from .config import Settings, get_settings
from .logging import configure_logging, get_logger
from .nudge_backends import NudgeEmailBackend, create_email_backend

log = get_logger("nudger")

RUN_INTERVAL_S = 24 * 60 * 60


@dataclass
class Deps:
    settings: Settings
    conn: Any  # psycopg.Connection
    email: NudgeEmailBackend | None


def _start_of_today(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _digest_text(owner_name: str, items: list[db.NudgeCandidate]) -> str:
    lines = [f"- {i.text} ({i.meeting_title}, due {i.due_date.date()})" for i in items]
    return f"Hi {owner_name},\n\nThese action items are overdue:\n\n" + "\n".join(lines)


def run_once(deps: Deps) -> int:
    """Returns how many action items were actually nudged (emailed)."""
    if deps.email is None:
        log.info("nudge.skipped_no_email_backend")
        return 0

    now = datetime.now(timezone.utc)
    cutoff = _start_of_today(now)
    candidates = db.get_nudge_candidates(deps.conn, now, cutoff)

    by_owner: dict[str, list[db.NudgeCandidate]] = {}
    for c in candidates:
        by_owner.setdefault(c.owner_user_id, []).append(c)

    nudged_ids: list[str] = []
    for owner_id, items in by_owner.items():
        try:
            deps.email.send_digest(
                items[0].owner_email,
                "Overdue action items",
                _digest_text(items[0].owner_name, items),
            )
        except Exception:
            # One owner's bad email address shouldn't stop everyone else's
            # digest — and this owner's items simply get retried tomorrow
            # (last_nudged_at only advances on success).
            log.error("nudge.email_failed", owner_id=owner_id, exc_info=True)
            continue
        nudged_ids.extend(i.id for i in items)

    if nudged_ids:
        db.mark_nudged(deps.conn, nudged_ids, now)
    log.info(
        "nudge.run_complete",
        candidates=len(candidates),
        owners=len(by_owner),
        emailed=len(nudged_ids),
    )
    return len(nudged_ids)


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    deps = Deps(
        settings=settings,
        conn=db.connect(settings.database_url),
        email=create_email_backend(settings),
    )
    while True:
        try:
            run_once(deps)
        except Exception:
            log.error("nudge.run_failed", exc_info=True)
            deps.conn.rollback()
        time.sleep(RUN_INTERVAL_S)


if __name__ == "__main__":
    main()
