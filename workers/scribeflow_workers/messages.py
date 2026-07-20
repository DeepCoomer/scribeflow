"""Queue message schemas — the pydantic side of the contract shared with
api/src/queue/messages.ts. Wire format is snake_case JSON. Schema changes
only ever add versioned fields, never mutate in place (CLAUDE.md)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


class MeetingUploadedV1(BaseModel):
    v: Literal[1] = 1
    # q.slicer now consumes two message shapes (meeting.uploaded and, ticket
    # 5.3, meeting.finalize) off the same queue — the worker framework's
    # Handler signature carries no routing key (framework.py), so this
    # discriminator is how slicer.py tells them apart. Defaulted so it never
    # breaks a message from before this field existed (CLAUDE.md: additive
    # schema changes only).
    type: Literal["meeting.uploaded"] = "meeting.uploaded"
    tenant_id: str
    meeting_id: str
    r2_key: str
    duration_hint_s: float | None = None


class MeetingFinalizeV1(BaseModel):
    """Ticket 5.3, D69: published by the bot orchestrator once a bot session
    reaches a terminal state with >=1 segment uploaded. Consumed by the
    slicer worker (it already owns ffmpeg/R2/the publish primitive, D51),
    which concatenates the bot's rolling segments into the meeting's
    canonical recording and republishes as a plain meeting.uploaded."""

    v: Literal[1] = 1
    type: Literal["meeting.finalize"] = "meeting.finalize"
    tenant_id: str
    meeting_id: str


class ChunkTranscribeV1(BaseModel):
    v: Literal[1] = 1
    tenant_id: str
    meeting_id: str
    chunk_idx: int
    total_chunks: int
    offset_s: float
    r2_key: str


class MeetingDiarizeV1(BaseModel):
    v: Literal[1] = 1
    tenant_id: str
    meeting_id: str
    r2_key: str


class MeetingStitchV1(BaseModel):
    v: Literal[1] = 1
    tenant_id: str
    meeting_id: str


class MeetingExtractV1(BaseModel):
    v: Literal[1] = 1
    tenant_id: str
    meeting_id: str


class MeetingEmbedV1(BaseModel):
    v: Literal[1] = 1
    tenant_id: str
    meeting_id: str


MeetingStatus = Literal[
    "pending", "uploading", "processing", "transcribing", "partial", "done", "failed"
]

ExtractionStatus = Literal["done", "failed"]


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


class ExtractionEventV1(BaseModel):
    """Published by the extractor (3.1/3.2, D59) once its job reaches a
    terminal state — separate from StatusEventV1 because extraction never
    changes `meetings.status` (a stitched transcript is already `done`/
    `partial` regardless of whether the intelligence pass has run yet)."""

    v: Literal[1] = 1
    type: Literal["meeting.extraction"] = "meeting.extraction"
    tenant_id: str
    meeting_id: str
    status: ExtractionStatus
    error: str | None = None
    ts: str = Field(default_factory=_now_iso)


# Anything a worker can publish to the `events` fanout (framework.py's
# JobContext.publish_event is generic over this).
PipelineEventV1 = StatusEventV1 | ExtractionEventV1
