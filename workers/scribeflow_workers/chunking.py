"""Chunk-plan math shared by the slicer (writes chunks) and the stitcher
(reconstructs the same plan to compute coverage gaps) — D46, D49.

Both callers must derive identical offsets from the same duration, which is
what makes redelivery and re-stitching deterministic (D11); keep the formula
in exactly one place.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

CHUNK_S = 300.0
OVERLAP_S = 10.0
STRIDE_S = CHUNK_S - OVERLAP_S
MIN_FINAL_S = 30.0


@dataclass(frozen=True)
class ChunkSpec:
    chunk_idx: int
    offset_s: float
    # None means "run to end of file" — the actual last chunk of the meeting.
    duration_s: float | None


def compute_chunk_plan(duration_s: float) -> list[ChunkSpec]:
    """D46: n = max(1, ceil((D - overlap) / stride)); the final chunk is
    open-ended, and a final chunk under MIN_FINAL_S is absorbed into its
    predecessor (which then runs open-ended instead)."""
    n = max(1, math.ceil((duration_s - OVERLAP_S) / STRIDE_S))
    offsets = [i * STRIDE_S for i in range(n)]
    if n > 1 and duration_s - offsets[-1] < MIN_FINAL_S:
        offsets.pop()
        n -= 1
    return [
        ChunkSpec(chunk_idx=i, offset_s=offset, duration_s=None if i == n - 1 else CHUNK_S)
        for i, offset in enumerate(offsets)
    ]


def cut_point(chunk_idx: int) -> float:
    """Midpoint of the overlap between chunk_idx and chunk_idx + 1 (D11)."""
    return (chunk_idx + 1) * STRIDE_S + OVERLAP_S / 2


def chunk_end_s(spec: ChunkSpec, duration_s: float) -> float:
    return duration_s if spec.duration_s is None else spec.offset_s + spec.duration_s
