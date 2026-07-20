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


def generate_silence(dest: Path, duration_s: float) -> None:
    """A silent clip matching the bot's capture format (ticket 5.3, D69) —
    used to pad a wall-clock gap between two segments (a crash + rejoin
    leaves a hole) so every downstream timestamp stays absolute
    (invariant 4)."""
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=16000:cl=mono",
            "-t",
            str(duration_s),
            "-c:a",
            "libopus",
            "-b:a",
            "24k",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )


def concat_audio(inputs: list[Path], dest: Path) -> None:
    """Concatenates real bot segments and generated silence padding into one
    file via ffmpeg's concat demuxer. Re-encodes rather than stream-copying
    (D69: "costs seconds of CPU and one ~30 MB round trip — nothing at our
    scale") — simpler and more robust than requiring every input to already
    share identical stream parameters for a copy-mode concat."""
    list_path = dest.parent / "concat_list.txt"
    list_path.write_text("".join(f"file '{p.resolve()}'\n" for p in inputs))
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libopus",
            "-b:a",
            "24k",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )
