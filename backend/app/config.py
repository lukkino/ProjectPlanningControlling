from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """App configuration, read from environment / .env file.

    The jira_* fields here are used only to seed the app_settings DB row on
    first startup after the Configurazione section was introduced (see
    database.run_lightweight_migrations) - at runtime the source of truth is
    that DB row (models.AppSettings), editable from the UI without touching
    .env or restarting the server. database_url stays env-only.
    """

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "sqlite:///./data/app.db"

    # Cookie di sessione solo su HTTPS: da attivare (COOKIE_SECURE=true nel
    # .env) quando il server e' raggiungibile in https.
    cookie_secure: bool = False
    # Durata di una sessione di login senza attivita' (giorni).
    session_days: int = 7

    jira_base_url: str = ""
    jira_email: str = ""
    jira_api_token: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
