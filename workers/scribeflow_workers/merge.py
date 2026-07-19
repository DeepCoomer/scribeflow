"""Speaker-transcript merge (ticket 2.6, D55-D57): pure functions assigning
a diarized speaker to each stitched segment by maximum temporal overlap, plus
the interruption predicate and the default-name numbering the stitcher seeds
`meeting_speakers` with. No I/O and no db/broker imports here on purpose —
the stitcher (the only caller) owns persistence, and determinism here is what
keeps a re-stitch idempotent (same argument as the dedup rules in D11).

Run: imported by scribeflow_workers.stitcher, not run standalone.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence

# >30% overlap with a non-assigned speaker flags an interruption (D13,
# sharpened by D57). Defined here as a pure function; not materialized onto
# any row until Phase 4.1's utterance_metrics reads speaker_turns directly.
INTERRUPTION_OVERLAP_FRACTION = 0.3


class SegmentLike(Protocol):
    # Properties, not plain attributes: StitchSegmentRow (the real caller)
    # is a frozen dataclass, and mypy only matches a Protocol's read-only
    # members against read-only attributes.
    @property
    def id(self) -> str: ...
    @property
    def start_s(self) -> float: ...
    @property
    def end_s(self) -> float: ...


@dataclass(frozen=True)
class SpeakerTurn:
    speaker_label: str
    start_s: float
    end_s: float


@dataclass(frozen=True)
class MergeResult:
    # segment id -> diarized label, or None when no turn overlaps it at all
    # (D55: no nearest-turn fallback, no minimum-overlap threshold).
    assignments: dict[str, str | None]
    # diarized label -> default display name ("Speaker N"), numbered by
    # first turn start (D56) — the stitcher seeds meeting_speakers with these
    # via ON CONFLICT DO NOTHING so a rename is never clobbered.
    default_names: dict[str, str]


def _overlap_s(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _overlap_totals_by_label(
    seg_start: float, seg_end: float, turns: Sequence[SpeakerTurn]
) -> dict[str, float]:
    """Sum overlap per label across all of that label's turns (D55) — a
    single continuous speech run is frequently split into adjacent pyannote
    turns, so comparing one turn at a time would undercount the true
    speaker."""
    totals: dict[str, float] = {}
    for turn in turns:
        ov = _overlap_s(seg_start, seg_end, turn.start_s, turn.end_s)
        if ov <= 0:
            continue
        totals[turn.speaker_label] = totals.get(turn.speaker_label, 0.0) + ov
    return totals


def assign_speakers(
    segments: Sequence[SegmentLike], turns: Sequence[SpeakerTurn]
) -> dict[str, str | None]:
    """Maximum-overlap assignment per segment. Ties (equal summed overlap,
    a degenerate case) go to the lexicographically smallest label — the
    tie-break exists only for determinism, not to encode a preference."""
    assignments: dict[str, str | None] = {}
    for seg in segments:
        totals = _overlap_totals_by_label(seg.start_s, seg.end_s, turns)
        if not totals:
            assignments[seg.id] = None
            continue
        best_total = max(totals.values())
        winners = sorted(label for label, total in totals.items() if total == best_total)
        assignments[seg.id] = winners[0]
    return assignments


def interrupting_labels(
    seg: SegmentLike, turns: Sequence[SpeakerTurn], assigned_label: str | None
) -> set[str]:
    """Labels other than the assigned one overlapping this segment by more
    than 30% of its duration (D13/D57): the double-overlap case the
    interruption metric wants. Pure and unused by the stitcher's own
    persistence path today — Phase 4.1 is the first materialized reader."""
    duration = seg.end_s - seg.start_s
    if duration <= 0:
        return set()
    totals = _overlap_totals_by_label(seg.start_s, seg.end_s, turns)
    threshold = INTERRUPTION_OVERLAP_FRACTION * duration
    return {
        label
        for label, total in totals.items()
        if label != assigned_label and total > threshold
    }


def default_display_names(turns: Sequence[SpeakerTurn]) -> dict[str, str]:
    """"Speaker N", numbered by first turn start — the first voice heard is
    Speaker 1 (D56). Deterministic given the same turns, so re-stitching
    recomputes the identical default set (the seed insert's ON CONFLICT DO
    NOTHING is what actually protects a user's rename, not this function)."""
    first_start: dict[str, float] = {}
    for turn in turns:
        current = first_start.get(turn.speaker_label)
        if current is None or turn.start_s < current:
            first_start[turn.speaker_label] = turn.start_s
    ordered_labels = sorted(first_start, key=lambda label: first_start[label])
    return {label: f"Speaker {i + 1}" for i, label in enumerate(ordered_labels)}


def merge_speakers(
    segments: Sequence[SegmentLike], turns: Sequence[SpeakerTurn]
) -> MergeResult:
    """The stitcher's single entry point: segment->label assignments plus
    the default name seed, computed from the same turns."""
    return MergeResult(
        assignments=assign_speakers(segments, turns),
        default_names=default_display_names(turns),
    )
