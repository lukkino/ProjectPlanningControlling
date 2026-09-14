"""Minimal Jira Cloud REST API v3 client, used to sync a project's backlog
from a JQL query. Only reads issues — never writes anything back to Jira.
"""

import httpx

from app.config import Settings

SEARCH_PATH = "/rest/api/3/search/jql"


class JiraClientError(Exception):
    """Raised for any Jira configuration or API failure, with a message
    safe to surface to the frontend."""


class JiraIssue:
    def __init__(self, key: str, issue_type: str, summary: str, status: str, labels: list[str]):
        self.key = key
        self.issue_type = issue_type
        self.summary = summary
        self.status = status
        self.labels = labels


def search_issues(settings: Settings, jql: str) -> list[JiraIssue]:
    if not settings.jira_configured:
        raise JiraClientError(
            "Integrazione Jira non configurata: compila JIRA_BASE_URL, JIRA_EMAIL "
            "e JIRA_API_TOKEN nel file backend/.env"
        )

    base_url = settings.jira_base_url.rstrip("/")
    auth = (settings.jira_email, settings.jira_api_token)
    fields = ["summary", "issuetype", "status", "labels"]

    issues: list[JiraIssue] = []
    next_page_token: str | None = None

    try:
        with httpx.Client(auth=auth, timeout=30.0) as client:
            while True:
                payload = {"jql": jql, "maxResults": 100, "fields": fields}
                if next_page_token:
                    payload["nextPageToken"] = next_page_token

                response = client.post(f"{base_url}{SEARCH_PATH}", json=payload)
                if response.status_code == 401:
                    raise JiraClientError("Autenticazione Jira fallita: verifica email e API token in .env")
                if response.status_code == 400:
                    raise JiraClientError(f"JQL non valida: {response.text}")
                response.raise_for_status()
                data = response.json()

                for raw in data.get("issues", []):
                    f = raw.get("fields", {})
                    issues.append(
                        JiraIssue(
                            key=raw.get("key", ""),
                            issue_type=(f.get("issuetype") or {}).get("name", ""),
                            summary=f.get("summary", ""),
                            status=(f.get("status") or {}).get("name", ""),
                            labels=f.get("labels") or [],
                        )
                    )

                next_page_token = data.get("nextPageToken")
                if not next_page_token or data.get("isLast", True):
                    break
    except httpx.HTTPError as exc:
        raise JiraClientError(f"Errore di comunicazione con Jira: {exc}") from exc

    return issues
