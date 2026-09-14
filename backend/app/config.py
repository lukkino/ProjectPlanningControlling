from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """App configuration, read from environment / .env file.

    Jira credentials are intentionally kept out of the database: they live
    only in this process' environment, loaded from backend/.env (gitignored).
    """

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "sqlite:///./data/app.db"

    jira_base_url: str = ""
    jira_email: str = ""
    jira_api_token: str = ""

    @property
    def jira_configured(self) -> bool:
        return bool(self.jira_base_url and self.jira_email and self.jira_api_token)


@lru_cache
def get_settings() -> Settings:
    return Settings()
