"""D46 chunk-plan math: count/offset formula, short-final-chunk absorption,
and the cut-point/gap helpers the stitcher reconstructs the same plan with."""

from __future__ import annotations

from scribeflow_workers.chunking import (
    CHUNK_S,
    MIN_FINAL_S,
    STRIDE_S,
    ChunkSpec,
    chunk_end_s,
    compute_chunk_plan,
    cut_point,
)


def test_single_chunk_for_short_meeting() -> None:
    plan = compute_chunk_plan(120.0)
    assert plan == [ChunkSpec(chunk_idx=0, offset_s=0.0, duration_s=None)]


def test_exactly_one_chunk_boundary() -> None:
    # (300 - 10) / 290 = 1.0 -> ceil = 1: the D <= 300s degenerate case.
    plan = compute_chunk_plan(300.0)
    assert len(plan) == 1
    assert plan[0].duration_s is None


def test_two_full_chunks() -> None:
    # 590s -> ceil((590-10)/290) = 2 exactly; the naive final length (300s)
    # is nowhere near the 30s absorption floor, so it stays its own chunk.
    duration = 590.0
    plan = compute_chunk_plan(duration)
    assert [c.chunk_idx for c in plan] == [0, 1]
    assert plan[0] == ChunkSpec(0, 0.0, CHUNK_S)
    assert plan[1] == ChunkSpec(1, STRIDE_S, None)
    assert chunk_end_s(plan[1], duration) == duration


def test_short_final_chunk_is_absorbed_into_predecessor() -> None:
    # Naive 3-chunk plan's final length = 600 - 580 = 20s < 30s floor, so it
    # merges into chunk 1 instead of staying a tiny third chunk.
    duration = 600.0
    plan = compute_chunk_plan(duration)
    assert [c.chunk_idx for c in plan] == [0, 1]
    assert plan[1] == ChunkSpec(1, STRIDE_S, None)
    assert chunk_end_s(plan[1], duration) == duration
    assert chunk_end_s(plan[1], duration) - plan[1].offset_s == 310.0


def test_absorbed_chunk_stays_within_the_documented_bound() -> None:
    # D46: absorption only ever happens when the naive final chunk is under
    # MIN_FINAL_S, so the merged chunk's length is always in (CHUNK_S,
    # CHUNK_S + MIN_FINAL_S) -- strictly more than a full chunk, never as
    # much as a full chunk plus the absorption floor.
    for naive_final in range(11, int(MIN_FINAL_S)):
        duration = 2 * STRIDE_S + naive_final
        plan = compute_chunk_plan(duration)
        assert plan[-1].duration_s is None
        length = chunk_end_s(plan[-1], duration) - plan[-1].offset_s
        assert CHUNK_S < length < CHUNK_S + MIN_FINAL_S


def test_many_chunks_cover_the_whole_meeting_with_overlap() -> None:
    duration = 3600.0  # 1 hour
    plan = compute_chunk_plan(duration)
    assert len(plan) == 13  # matches docs/architecture.md's "one Groq burst"
    for i, spec in enumerate(plan):
        assert spec.chunk_idx == i
        assert spec.offset_s == i * STRIDE_S
    assert plan[-1].duration_s is None
    assert chunk_end_s(plan[-1], duration) == duration


def test_cut_point_is_overlap_midpoint() -> None:
    # Overlap between chunk 0 [0,300) and chunk 1 [290,580) is [290,300);
    # the midpoint is 295.
    assert cut_point(0) == 295.0
