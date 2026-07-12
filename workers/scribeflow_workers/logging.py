"""Structured JSON logging (ticket 1.3): one JSON object per line so the VM's
`docker logs` output is grep- and jq-able. Workers log events, not prose —
call sites pass an event name plus fields, never interpolated strings."""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "event": record.getMessage(),
        }
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            entry.update(fields)
        if record.exc_info and record.exc_info[1] is not None:
            entry["error"] = repr(record.exc_info[1])
        return json.dumps(entry, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())


class StructLogger:
    """Thin wrapper making `log.info("event", meeting_id=...)` the only way
    call sites can log — keeps every line machine-parseable."""

    def __init__(self, name: str) -> None:
        self._logger = logging.getLogger(name)

    def _log(self, level: int, event: str, exc_info: bool, fields: dict[str, Any]) -> None:
        self._logger.log(level, event, exc_info=exc_info, extra={"fields": fields})

    def info(self, event: str, **fields: Any) -> None:
        self._log(logging.INFO, event, False, fields)

    def warning(self, event: str, **fields: Any) -> None:
        self._log(logging.WARNING, event, False, fields)

    def error(self, event: str, exc_info: bool = False, **fields: Any) -> None:
        self._log(logging.ERROR, event, exc_info, fields)


def get_logger(name: str) -> StructLogger:
    return StructLogger(name)
