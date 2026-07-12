from scribeflow_workers.topology import (
    MAX_ATTEMPTS,
    RETRY_TIERS,
    retry_queue_name,
    retry_tier_for_attempt,
)


def test_retry_ladder_escalates_then_exhausts() -> None:
    assert retry_tier_for_attempt(1) == RETRY_TIERS[0]
    assert retry_tier_for_attempt(2) == RETRY_TIERS[1]
    assert retry_tier_for_attempt(3) == RETRY_TIERS[2]
    assert retry_tier_for_attempt(MAX_ATTEMPTS) is None


def test_max_attempts_matches_tier_count() -> None:
    assert MAX_ATTEMPTS == 1 + len(RETRY_TIERS)


def test_retry_queue_naming() -> None:
    assert retry_queue_name("q.transcriber", "30s") == "q.transcriber.retry.30s"
