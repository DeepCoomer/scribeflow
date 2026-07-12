"""Queue message schemas — the pydantic side of the contract shared with
api/src/queue/messages.ts. Wire format is snake_case JSON. Schema changes
only ever add versioned fields, never mutate in place (CLAUDE.md)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


class MeetingUploadedV1(BaseModel):
    v: Literal[1] = 1
    tenant_id: str
    meeting_id: str
    r2_key: str
    duration_hint_s: float | None = None


MeetingStatus = Literal[
    "pending", "uploading", "processing", "transcribing", "partial", "done", "failed"
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class StatusEventV1(BaseModel):
    """Published to the `events` fanout at every state transition; the API
    forwards these to SSE subscribers (ticket 1.6)."""

    v: Literal[1] = 1
    type: Literal["meeting.status"] = "meeting.status"
    tenant_id: str
    meeting_id: str
    status: MeetingStatus
    error: str | None = None
    ts: str = Field(default_factory=_now_iso)
