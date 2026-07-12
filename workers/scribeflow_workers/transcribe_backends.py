"""Transcription backends behind one interface — the D22 fallback switch,
built from day one: TRANSCRIBE_BACKEND=groq is the default; =local runs a
whisper.cpp-style CLI so a Groq free-tier change is a config edit, not an
outage. Both return segments in file-relative seconds; the caller shifts to
absolute meeting time (invariant 4)."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel

from .config import Settings


class Segment(BaseModel):
    start_s: float
    end_s: float
    text: str
    words: list[dict[str, Any]] | None = None


class TranscribeBackend(Protocol):
    def transcribe(self, audio_path: Path) -> list[Segment]: ...


def parse_verbose_json(payload: dict[str, Any]) -> list[Segment]:
    """Whisper `verbose_json` → segments. Shared by the Groq backend and the
    fixture-based tests (no live Groq calls in CI)."""
    segments: list[Segment] = []
    for seg in payload.get("segments", []):
        text = str(seg["text"]).strip()
        if not text:
            continue
        segments.append(
            Segment(
                start_s=float(seg["start"]),
                end_s=float(seg["end"]),
                text=text,
                words=seg.get("words"),
            )
        )
    return segments


class GroqBackend:
    def __init__(self, settings: Settings) -> None:
        # Imported lazily so the local backend doesn't require the SDK.
        from groq import Groq

        self._client = Groq(api_key=settings.groq_api_key)
        self._model = settings.groq_whisper_model

    def transcribe(self, audio_path: Path) -> list[Segment]:
        with audio_path.open("rb") as f:
            response = self._client.audio.transcriptions.create(
                file=(audio_path.name, f),
                model=self._model,
                response_format="verbose_json",
            )
        return parse_verbose_json(response.model_dump())


class LocalWhisperBackend:
    """Runs a whisper.cpp-style CLI producing a verbose_json-compatible file.
    The command template comes from LOCAL_WHISPER_CMD, e.g.
    `whisper-cli -m /models/ggml-large-v3-turbo.bin -f {input} -oj -of {output_base}`.
    """

    def __init__(self, settings: Settings) -> None:
        if not settings.local_whisper_cmd:
            raise ValueError("LOCAL_WHISPER_CMD must be set for the local backend")
        self._cmd_template = settings.local_whisper_cmd

    def transcribe(self, audio_path: Path) -> list[Segment]:
        with tempfile.TemporaryDirectory() as tmp:
            output_base = Path(tmp) / "transcript"
            cmd = self._cmd_template.format(
                input=str(audio_path), output_base=str(output_base)
            )
            subprocess.run(cmd, shell=True, check=True, capture_output=True)
            payload = json.loads((output_base.with_suffix(".json")).read_text())
        return parse_verbose_json(payload)


def create_backend(settings: Settings) -> TranscribeBackend:
    if settings.transcribe_backend == "groq":
        return GroqBackend(settings)
    if settings.transcribe_backend == "local":
        return LocalWhisperBackend(settings)
    raise ValueError(f"unknown TRANSCRIBE_BACKEND {settings.transcribe_backend!r}")
