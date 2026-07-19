"""Worker configuration — every value comes from the environment (VM .env
via compose, or workers/.env locally). See workers/.env.example for docs."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    rabbitmq_url: str = "amqp://scribeflow:scribeflow@localhost:5672"
    database_url: str = "postgres://scribeflow:scribeflow@localhost:55432/scribeflow"

    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket: str = "scribeflow"
    r2_endpoint: str = ""  # derived from account id when empty

    groq_api_key: str = ""
    groq_whisper_model: str = "whisper-large-v3-turbo"
    # D22: the fallback switch is built from day one. "groq" | "local".
    transcribe_backend: str = "groq"

    # Phase 3 (3.1/3.2, D21/D59): same Groq account, LLM model for extraction
    # + sentiment. Its own rate-limiter bucket (rate_limiter.py) since Groq's
    # free-tier limits are per-model, not shared with the Whisper quota.
    groq_llm_model: str = "llama-3.3-70b-versatile"
    groq_llm_rate_per_min: float = 20.0
    # Command template for the local backend (whisper.cpp); {input} and
    # {output_json} are substituted. Only used when transcribe_backend=local.
    local_whisper_cmd: str = ""

    # D23: pyannote's pretrained pipeline is a gated HF model — needs a token
    # with the license accepted (docs/infrastructure.md setup step 7).
    hf_token: str = ""
    pyannote_model: str = "pyannote/speaker-diarization-3.1"

    # Ticket 3.5 (D63): CPU sentence-transformers, one model instance per
    # embedder process. all-MiniLM-L6-v2 is the standard small model this
    # library ships — 384 dims, matching the api/src/lib/embeddings.ts
    # Xenova ONNX port of the same weights used for query-time embedding.
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    # Ticket 3.8 (D66): the nudger's optional email digest — same Resend
    # account as the API's summary/follow-up emails (api/.env.example), but
    # its own key here since the workers don't share a process with the API.
    # Unset means the nudger only logs candidates, no email sent (same
    # "optional, or skip" pattern as everywhere else this key shows up).
    resend_api_key: str = ""
    resend_from_email: str = "ScribeFlow <notifications@scribeflow.deepcoomer.dev>"

    log_level: str = "INFO"

    @property
    def r2_endpoint_url(self) -> str:
        if self.r2_endpoint:
            return self.r2_endpoint
        return f"https://{self.r2_account_id}.r2.cloudflarestorage.com"


@lru_cache
def get_settings() -> Settings:
    return Settings()
