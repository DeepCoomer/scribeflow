"""Email backend for the nudger (ticket 3.8, D66): a single Resend HTTP POST,
behind a Protocol so tests run against a fake — no live Resend call, same
shape as extract_backends.py/embed_backends.py. Mirrors api/src/lib/
email.ts's "a single POST doesn't need a full SDK" reasoning.
"""

from __future__ import annotations

from typing import Protocol

from .config import Settings


class NudgeEmailBackend(Protocol):
    def send_digest(self, to: str, subject: str, text: str) -> None: ...


class ResendEmailBackend:
    def __init__(self, settings: Settings) -> None:
        self._api_key = settings.resend_api_key
        self._from = settings.resend_from_email

    def send_digest(self, to: str, subject: str, text: str) -> None:
        # Imported lazily, same reasoning as the other backends' lazy SDK
        # imports — this only runs in the nudger process.
        import httpx

        resp = httpx.post(
            "https://api.resend.com/emails",
            headers={"authorization": f"Bearer {self._api_key}"},
            json={"from": self._from, "to": to, "subject": subject, "text": text},
            timeout=10.0,
        )
        resp.raise_for_status()


def create_email_backend(settings: Settings) -> NudgeEmailBackend | None:
    if not settings.resend_api_key:
        return None
    return ResendEmailBackend(settings)
