"""Diarization backend (ticket 2.5). pyannote.audio is a heavy, optional
dependency (`uv sync --extra diarize`) — imported lazily inside the backend's
constructor, same pattern as transcribe_backends.GroqBackend, so importing
this module (and running the diarizer's tests via a fake backend) never
requires torch/pyannote to be installed."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from pydantic import BaseModel

from .config import Settings


class SpeakerTurn(BaseModel):
    speaker: str
    start_s: float
    end_s: float


class DiarizeBackend(Protocol):
    def diarize(self, audio_path: Path) -> list[SpeakerTurn]: ...


class PyannoteBackend:
    def __init__(self, settings: Settings) -> None:
        from pyannote.audio import Pipeline

        self._pipeline = Pipeline.from_pretrained(
            settings.pyannote_model, use_auth_token=settings.hf_token
        )

    def diarize(self, audio_path: Path) -> list[SpeakerTurn]:
        result = self._pipeline(str(audio_path))
        return [
            SpeakerTurn(speaker=str(speaker), start_s=turn.start, end_s=turn.end)
            for turn, _, speaker in result.itertracks(yield_label=True)
        ]


def create_backend(settings: Settings) -> DiarizeBackend:
    return PyannoteBackend(settings)
