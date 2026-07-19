"""LLM backends for the intelligence pass (tickets 3.1/3.2, D59): action
items / decisions / summary extraction, and batched per-utterance sentiment
scoring. Both go through Groq chat completions in JSON mode, behind a
Protocol so tests run against fixtures/fakes — no live Groq calls in CI
(CLAUDE.md test conventions), same shape as transcribe_backends.py.
"""

from __future__ import annotations

import json
from typing import Any, Protocol

from pydantic import BaseModel, Field, ValidationError

from .config import Settings

# "strict JSON schema output with retry-on-invalid" (ticket 3.1): a call that
# comes back as malformed JSON or fails schema validation gets re-prompted
# in-line, quoting the parse error, up to this many total attempts before
# the handler gives up and raises (letting the queue's own retry ladder,
# D43, take over for whatever's wrong beyond a prompt nudge).
MAX_LLM_ATTEMPTS = 3

# Batched sentiment calls (ticket 3.2): small enough that one bad batch is
# cheap to redo, large enough that a 1-hour meeting (~500-700 utterances)
# takes single-digit calls.
SENTIMENT_BATCH_SIZE = 40

SentimentLabel = str  # "positive" | "neutral" | "negative" — not enum-typed
# on the wire since it rides inside free-form LLM JSON; validated by
# SentimentResult below.


class ExtractedActionItem(BaseModel):
    text: str
    # Free-text name read off the transcript (a speaker display name, most
    # often) — never resolved to a real user id here (D59: candidate, not
    # assignment, same caution as D56's calendar-attendee names).
    owner_name: str | None = None
    due_date: str | None = None  # ISO 8601 date or datetime, or null
    confidence: float = Field(ge=0.0, le=1.0)
    # Approximate meeting-time seconds this item was discussed at, per the
    # [mm:ss] markers in the prompt transcript — advisory, used only to link
    # the UI to the nearest transcript segment (no FK, D59).
    source_ts_s: float | None = None


class ExtractedDecision(BaseModel):
    text: str
    source_ts_s: float | None = None


class ExtractionResult(BaseModel):
    summary: str
    decisions: list[ExtractedDecision] = Field(default_factory=list)
    action_items: list[ExtractedActionItem] = Field(default_factory=list)


class SentimentResult(BaseModel):
    segment_id: str
    label: SentimentLabel
    score: float = Field(ge=-1.0, le=1.0)


class SentimentBatchResult(BaseModel):
    results: list[SentimentResult]


EXTRACTION_SYSTEM_PROMPT = """\
You read a meeting transcript (lines formatted "[mm:ss] Speaker: text") and \
extract structured information. Respond with ONLY a single JSON object, no \
prose before or after, matching exactly this shape:

{
  "summary": "2-4 sentence summary of what the meeting covered and any outcome",
  "decisions": [{"text": "a decision the group reached", "source_ts_s": <seconds as a number, or null>}],
  "action_items": [
    {
      "text": "a concrete commitment someone made",
      "owner_name": "the speaker's name if it's clear who owns it, else null",
      "due_date": "an ISO 8601 date like 2026-08-01 if a deadline was stated, else null",
      "confidence": <number between 0 and 1 for how clearly this was actually committed to>,
      "source_ts_s": <the [mm:ss] timestamp converted to seconds where this was said, or null>
    }
  ]
}

Only extract action items that are concrete commitments ("I'll send the doc \
by Friday"), not general discussion or opinions. decisions and action_items \
are both empty arrays when the transcript has none. Never include markdown \
fences or any text outside the JSON object.\
"""

SENTIMENT_SYSTEM_PROMPT = """\
You score the emotional tone of individual meeting utterances. You will be \
given a JSON array of {"segment_id": "...", "text": "..."} objects. Respond \
with ONLY a single JSON object, no prose before or after, of this shape:

{"results": [{"segment_id": "<same id>", "label": "positive"|"neutral"|"negative", "score": <number from -1 (very negative) to 1 (very positive)>}]}

Include exactly one result per input segment_id, in any order. Neutral, \
factual statements should score near 0. Never include markdown fences or any \
text outside the JSON object.\
"""


def _chat_json(
    client: Any, model: str, system_prompt: str, user_content: str
) -> dict[str, Any]:
    """Chat-completion in JSON mode with the retry-on-invalid loop (ticket
    3.1): a response that isn't valid JSON gets re-prompted with the parse
    error, up to MAX_LLM_ATTEMPTS total calls."""
    messages: list[dict[str, str]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]
    last_error: Exception | None = None
    for _ in range(MAX_LLM_ATTEMPTS):
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.2,
        )
        content = response.choices[0].message.content or ""
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as err:
            last_error = err
        else:
            if isinstance(parsed, dict):
                return parsed
            last_error = ValueError("response was valid JSON but not an object")
        messages.append({"role": "assistant", "content": content})
        messages.append(
            {
                "role": "user",
                "content": (
                    f"That was not a valid JSON object ({last_error}). "
                    "Reply again with ONLY the corrected JSON object."
                ),
            }
        )
    raise ValueError(
        f"no valid JSON object after {MAX_LLM_ATTEMPTS} attempts: {last_error}"
    )


class ExtractionBackend(Protocol):
    def extract(self, transcript: str) -> ExtractionResult: ...

    def score_sentiment(
        self, utterances: list[tuple[str, str]]
    ) -> list[SentimentResult]:
        """utterances: (segment_id, text) pairs. Batched internally
        (SENTIMENT_BATCH_SIZE); a batch's failure (after its own retry-on-
        invalid attempts) propagates, same as extract()."""
        ...


class GroqExtractionBackend:
    def __init__(self, settings: Settings) -> None:
        # Imported lazily, same reasoning as transcribe_backends.GroqBackend.
        from groq import Groq

        self._client = Groq(api_key=settings.groq_api_key)
        self._model = settings.groq_llm_model

    def extract(self, transcript: str) -> ExtractionResult:
        raw = _chat_json(self._client, self._model, EXTRACTION_SYSTEM_PROMPT, transcript)
        try:
            return ExtractionResult.model_validate(raw)
        except ValidationError as err:
            raise ValueError(f"extraction JSON failed schema validation: {err}") from err

    def score_sentiment(self, utterances: list[tuple[str, str]]) -> list[SentimentResult]:
        results: list[SentimentResult] = []
        for start in range(0, len(utterances), SENTIMENT_BATCH_SIZE):
            batch = utterances[start : start + SENTIMENT_BATCH_SIZE]
            payload = json.dumps(
                [{"segment_id": seg_id, "text": text} for seg_id, text in batch]
            )
            raw = _chat_json(self._client, self._model, SENTIMENT_SYSTEM_PROMPT, payload)
            try:
                parsed = SentimentBatchResult.model_validate(raw)
            except ValidationError as err:
                raise ValueError(
                    f"sentiment JSON failed schema validation: {err}"
                ) from err
            results.extend(parsed.results)
        return results


def create_extraction_backend(settings: Settings) -> ExtractionBackend:
    return GroqExtractionBackend(settings)
