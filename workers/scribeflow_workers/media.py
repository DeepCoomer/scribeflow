"""ffprobe/ffmpeg wrappers for the slicer (ticket 2.2). Kept as thin,
individually-mockable functions — tests fake these the same way existing
tests fake `r2.download`, so no real ffmpeg/ffprobe binary is needed in CI.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


def probe_duration_s(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        check=True,
        text=True,
    )
    return float(json.loads(result.stdout)["format"]["duration"])


def slice_to_flac(
    src: Path, dest: Path, offset_s: float, duration_s: float | None
) -> None:
    """Re-encode (never stream copy, D47) so `offset_s` lands on a sample-exact
    cut: input-side `-ss` combined with an actual re-encode is accurate, not
    keyframe-snapped like stream copy would be."""
    cmd = ["ffmpeg", "-y", "-ss", str(offset_s), "-i", str(src)]
    if duration_s is not None:
        cmd += ["-t", str(duration_s)]
    cmd += ["-ac", "1", "-ar", "16000", str(dest)]
    subprocess.run(cmd, check=True, capture_output=True)
