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
    # Command template for the local backend (whisper.cpp); {input} and
    # {output_json} are substituted. Only used when transcribe_backend=local.
    local_whisper_cmd: str = ""

    log_level: str = "INFO"

    @property
    def r2_endpoint_url(self) -> str:
        if self.r2_endpoint:
            return self.r2_endpoint
        return f"https://{self.r2_account_id}.r2.cloudflarestorage.com"


@lru_cache
def get_settings() -> Settings:
    return Settings()
