"""Speaker-transcript merge tests (ticket 2.6): pure functions only, no
db/broker involved -- the stitcher integration is covered separately in
test_stitcher.py."""

from __future__ import annotations

from dataclasses import dataclass

from scribeflow_workers.merge import (
    SpeakerTurn,
    assign_speakers,
    default_display_names,
    interrupting_labels,
    merge_speakers,
)


@dataclass(frozen=True)
class Seg:
    id: str
    start_s: float
    end_s: float


def turn(label: str, start: float, end: float) -> SpeakerTurn:
    return SpeakerTurn(speaker_label=label, start_s=start, end_s=end)


# -- assign_speakers -----------------------------------------------------------


def test_assigns_the_label_with_maximum_overlap() -> None:
    segments = [Seg("a", 100.0, 110.0)]
    turns = [turn("SPEAKER_00", 95.0, 103.0), turn("SPEAKER_01", 103.0, 112.0)]
    assert assign_speakers(segments, turns) == {"a": "SPEAKER_01"}


def test_sums_overlap_across_multiple_turns_of_the_same_label() -> None:
    # SPEAKER_00 is split into two adjacent turns (a common pyannote
    # artifact); their combined overlap (4s) should beat SPEAKER_01's single
    # 3s turn even though no single SPEAKER_00 turn does alone (D55).
    segments = [Seg("a", 100.0, 110.0)]
    turns = [
        turn("SPEAKER_00", 99.0, 102.0),  # 2s overlap
        turn("SPEAKER_00", 102.0, 104.0),  # 2s overlap -> 4s total
        turn("SPEAKER_01", 104.0, 107.0),  # 3s overlap
    ]
    assert assign_speakers(segments, turns) == {"a": "SPEAKER_00"}


def test_zero_overlap_leaves_speaker_none() -> None:
    segments = [Seg("a", 100.0, 110.0)]
    turns = [turn("SPEAKER_00", 200.0, 210.0)]
    assert assign_speakers(segments, turns) == {"a": None}


def test_no_turns_at_all_leaves_every_segment_none() -> None:
    segments = [Seg("a", 100.0, 110.0), Seg("b", 200.0, 210.0)]
    assert assign_speakers(segments, []) == {"a": None, "b": None}


def test_tied_overlap_goes_to_the_lexicographically_smallest_label() -> None:
    segments = [Seg("a", 100.0, 110.0)]
    turns = [turn("SPEAKER_01", 100.0, 105.0), turn("SPEAKER_00", 105.0, 110.0)]
    assert assign_speakers(segments, turns) == {"a": "SPEAKER_00"}


def test_touching_but_not_overlapping_turn_counts_as_zero_overlap() -> None:
    # Half-open-interval-style edge: a turn that ends exactly where the
    # segment starts contributes no overlap.
    segments = [Seg("a", 100.0, 110.0)]
    turns = [turn("SPEAKER_00", 90.0, 100.0)]
    assert assign_speakers(segments, turns) == {"a": None}


# -- default_display_names ----------------------------------------------------


def test_default_names_numbered_by_first_turn_start() -> None:
    turns = [
        turn("SPEAKER_01", 50.0, 60.0),
        turn("SPEAKER_00", 10.0, 20.0),
        turn("SPEAKER_01", 5.0, 8.0),  # SPEAKER_01's true first start is 5.0
    ]
    assert default_display_names(turns) == {
        "SPEAKER_01": "Speaker 1",
        "SPEAKER_00": "Speaker 2",
    }


def test_default_names_empty_for_no_turns() -> None:
    assert default_display_names([]) == {}


# -- interrupting_labels --------------------------------------------------------


def test_interruption_flagged_above_30_percent_overlap() -> None:
    # 10s segment; SPEAKER_01 overlaps 4s (40% > 30%) while not being the
    # assigned speaker.
    seg = Seg("a", 100.0, 110.0)
    turns = [turn("SPEAKER_00", 100.0, 110.0), turn("SPEAKER_01", 106.0, 112.0)]
    assert interrupting_labels(seg, turns, "SPEAKER_00") == {"SPEAKER_01"}


def test_no_interruption_below_the_threshold() -> None:
    seg = Seg("a", 100.0, 110.0)
    turns = [turn("SPEAKER_00", 100.0, 110.0), turn("SPEAKER_01", 108.5, 112.0)]
    assert interrupting_labels(seg, turns, "SPEAKER_00") == set()


def test_assigned_label_is_never_its_own_interrupter() -> None:
    seg = Seg("a", 100.0, 110.0)
    turns = [turn("SPEAKER_00", 100.0, 110.0)]
    assert interrupting_labels(seg, turns, "SPEAKER_00") == set()


def test_zero_duration_segment_flags_no_interruption() -> None:
    seg = Seg("a", 100.0, 100.0)
    turns = [turn("SPEAKER_00", 90.0, 110.0)]
    assert interrupting_labels(seg, turns, None) == set()


# -- merge_speakers (combined entry point) ------------------------------------


def test_merge_speakers_combines_assignment_and_defaults() -> None:
    segments = [Seg("a", 100.0, 110.0)]
    turns = [turn("SPEAKER_00", 95.0, 115.0)]
    result = merge_speakers(segments, turns)
    assert result.assignments == {"a": "SPEAKER_00"}
    assert result.default_names == {"SPEAKER_00": "Speaker 1"}


def test_merge_speakers_is_deterministic_across_repeated_calls() -> None:
    # Same inputs -> same outputs, every time -- the property idempotent
    # re-stitching depends on (D55).
    segments = [Seg("a", 100.0, 110.0), Seg("b", 200.0, 210.0)]
    turns = [turn("SPEAKER_00", 95.0, 205.0), turn("SPEAKER_01", 205.0, 215.0)]
    first = merge_speakers(segments, turns)
    second = merge_speakers(segments, turns)
    assert first == second
