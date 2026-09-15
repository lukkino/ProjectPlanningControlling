"""Minimal Jira Cloud REST API v3 client, used to sync a project's backlog
from a JQL query. Only reads issues — never writes anything back to Jira.
"""

import datetime as dt

import httpx

from app.config import Settings

SEARCH_PATH = "/rest/api/3/search/jql"
CHANGELOG_PATH = "/rest/api/3/issue/{key}/changelog"

# Nome esatto (case-sensitive) dello stato Jira che segna l'inizio lavorazione
# per le Activity, diverso da "In Progress" usato da Story/Bug. Verificato sui
# dati reali del changelog: e' "On-Going", non "On-going"/"Ongoing".
ACTIVITY_START_STATUS = "On-Going"
DEFAULT_START_STATUS = "In Progress"
DONE_STATUS = "Done"


class JiraClientError(Exception):
    """Raised for any Jira configuration or API failure, with a message
    safe to surface to the frontend."""


class JiraIssue:
    def __init__(
        self,
        key: str,
        issue_type: str,
        summary: str,
        status: str,
        labels: list[str],
        logged_hours: float | None = None,
        actual_start: dt.date | None = None,
        actual_finish: dt.date | None = None,
        parent_key: str | None = None,
        parent_summary: str | None = None,
    ):
        self.key = key
        self.issue_type = issue_type
        self.summary = summary
        self.status = status
        self.labels = labels
        self.logged_hours = logged_hours
        self.actual_start = actual_start
        self.actual_finish = actual_finish
        self.parent_key = parent_key
        self.parent_summary = parent_summary


def _parse_jira_datetime(value: str) -> dt.datetime:
    # Formato Jira: "2026-07-24T15:28:43.019+0200"
    return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%f%z")


def _fetch_status_dates(
    client: httpx.Client, base_url: str, key: str, issue_type: str
) -> tuple[dt.date | None, dt.date | None]:
    """Ricava actual_start/actual_finish dallo storico transizioni di stato
    dell'issue (changelog), paginando finche' necessario. actual_start e' la
    PRIMA transizione verso lo stato di "in lavorazione" (On-Going per le
    Activity, In Progress per tutto il resto); actual_finish e' l'ULTIMA
    transizione verso Done (cosi' una issue riaperta e richiusa riflette la
    chiusura definitiva)."""
    start_status = ACTIVITY_START_STATUS if issue_type == "Activity" else DEFAULT_START_STATUS

    actual_start: dt.date | None = None
    actual_finish: dt.date | None = None
    start_at = 0

    while True:
        response = client.get(
            f"{base_url}{CHANGELOG_PATH.format(key=key)}",
            params={"startAt": start_at, "maxResults": 100},
        )
        response.raise_for_status()
        data = response.json()
        values = data.get("values", [])

        for history in values:
            for item in history.get("items", []):
                if item.get("field") != "status":
                    continue
                when = _parse_jira_datetime(history["created"]).date()
                to_status = item.get("toString")
                if to_status == start_status and actual_start is None:
                    actual_start = when
                if to_status == DONE_STATUS:
                    actual_finish = when  # ultima vince: le history sono in ordine cronologico crescente

        if data.get("isLast", True) or not values:
            break
        start_at += len(values)

    return actual_start, actual_finish


def search_issues(settings: Settings, jql: str) -> list[JiraIssue]:
    if not settings.jira_configured:
        raise JiraClientError(
            "Integrazione Jira non configurata: compila JIRA_BASE_URL, JIRA_EMAIL "
            "e JIRA_API_TOKEN nel file backend/.env"
        )

    base_url = settings.jira_base_url.rstrip("/")
    auth = (settings.jira_email, settings.jira_api_token)
    fields = ["summary", "issuetype", "status", "labels", "timetracking", "parent"]

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
                    key = raw.get("key", "")
                    issue_type = (f.get("issuetype") or {}).get("name", "")
                    time_spent_seconds = (f.get("timetracking") or {}).get("timeSpentSeconds")
                    actual_start, actual_finish = _fetch_status_dates(client, base_url, key, issue_type)
                    parent = f.get("parent") or {}
                    issues.append(
                        JiraIssue(
                            key=key,
                            issue_type=issue_type,
                            summary=f.get("summary", ""),
                            status=(f.get("status") or {}).get("name", ""),
                            labels=f.get("labels") or [],
                            logged_hours=(time_spent_seconds / 3600) if time_spent_seconds is not None else None,
                            actual_start=actual_start,
                            actual_finish=actual_finish,
                            parent_key=parent.get("key"),
                            parent_summary=(parent.get("fields") or {}).get("summary"),
                        )
                    )

                next_page_token = data.get("nextPageToken")
                if not next_page_token or data.get("isLast", True):
                    break
    except httpx.HTTPError as exc:
        raise JiraClientError(f"Errore di comunicazione con Jira: {exc}") from exc

    return issues
