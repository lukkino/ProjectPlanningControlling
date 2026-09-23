"""Minimal Jira Cloud REST API v3 client, used to sync a project's backlog
from a JQL query. Only reads issues — never writes anything back to Jira.
"""

import datetime as dt

import httpx

SEARCH_PATH = "/rest/api/3/search/jql"
CHANGELOG_PATH = "/rest/api/3/issue/{key}/changelog"

# Nome esatto (case-sensitive) dello stato Jira che segna l'inizio lavorazione
# per le Activity, diverso da "In Progress" usato da Story/Bug. Verificato sui
# dati reali del changelog: e' "On-Going", non "On-going"/"Ongoing".
ACTIVITY_START_STATUS = "On-Going"
DEFAULT_START_STATUS = "In Progress"
DONE_STATUS = "Done"

# Frase esatta (case-sensitive) usata da Jira per il link "Polaris work item
# link" quando l'issue corrente e' il lato "inward" della relazione, cioe'
# "questa Story/Bug e' implementata da <Task>".
IMPLEMENTED_BY_PHRASE = "is implemented by"


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
        implemented_by: list[dict] | None = None,
        description: str | None = None,
        change_description: str | None = None,
        problem_cause: str | None = None,
        components: str | None = None,
        dev_effort_hours: float | None = None,
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
        # Lista di {"key", "summary", "fix_version"} per i Task che
        # implementano questa issue (link Jira "is implemented by").
        self.implemented_by = implemented_by or []
        self.description = description
        # Campo custom Jira "Change Description" (customfield_10130): per i
        # Bug va in colonna D dei documenti generati al posto della
        # description standard.
        self.change_description = change_description
        # Campo custom Jira "Problem Cause" (customfield_10129) e campo
        # standard "Components" (nomi uniti da virgola): usati nel Release
        # Report generato.
        self.problem_cause = problem_cause
        self.components = components
        # Campo custom Jira "Developer Effort" (customfield_10146, solo
        # sulle Story): colonna "Ore stimate" del Backlog.
        self.dev_effort_hours = dev_effort_hours


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


def _extract_implemented_by(issuelinks: list[dict]) -> list[dict]:
    """Task collegati a questa issue tramite un link "is implemented by"
    (l'issue corrente e' il lato inward: "questa issue e' implementata
    da <Task>"). Fix version/labels/components vengono aggiunti in un
    secondo momento con una query batch, qui sono sempre None."""
    result = []
    for link in issuelinks:
        link_type = link.get("type", {})
        inward_issue = link.get("inwardIssue")
        if link_type.get("inward") == IMPLEMENTED_BY_PHRASE and inward_issue:
            result.append(
                {
                    "key": inward_issue.get("key"),
                    "summary": (inward_issue.get("fields") or {}).get("summary"),
                    "fix_version": None,
                    "labels": None,
                    "components": None,
                }
            )
    return result


def _adf_to_text(node: dict, depth: int = 0) -> str:
    """Converte in testo semplice un nodo ADF (Atlassian Document Format,
    il formato ricco della description di Jira Cloud). Non e' un rendering
    fedele (niente numerazione automatica delle liste), ma resta leggibile
    in una cella Excel: paragrafi separati da riga vuota, grassetto tra
    asterischi, elenchi con trattino e indentazione."""
    node_type = node.get("type")

    if node_type == "text":
        text = node.get("text", "")
        if any(m.get("type") == "strong" for m in node.get("marks", [])):
            text = f"*{text}*"
        return text
    if node_type == "hardBreak":
        return "\n"
    if node_type == "inlineCard":
        return node.get("attrs", {}).get("url", "")
    if node_type == "mention":
        return f"@{node.get('attrs', {}).get('text', '')}"

    children = node.get("content", [])

    if node_type == "paragraph":
        return "".join(_adf_to_text(c, depth) for c in children)
    if node_type == "listItem":
        prefix = "  " * depth + "- "
        parts = [_adf_to_text(c, depth) for c in children]
        parts = [p for p in parts if p]
        if not parts:
            return prefix
        return prefix + parts[0] + ("\n" + "\n".join(parts[1:]) if len(parts) > 1 else "")
    if node_type in ("orderedList", "bulletList"):
        return "\n".join(_adf_to_text(c, depth + 1) for c in children)
    if node_type == "doc":
        parts = [_adf_to_text(c, depth) for c in children]
        return "\n\n".join(p for p in parts if p.strip())

    return "".join(_adf_to_text(c, depth) for c in children)


def _extract_description(description_adf: dict | None) -> str | None:
    if not description_adf:
        return None
    text = _adf_to_text(description_adf).strip()
    return text or None


def _fetch_task_details(client: httpx.Client, base_url: str, keys: list[str]) -> dict[str, dict]:
    """Una singola query batch (paginata se necessario) per fix version,
    labels e components di un elenco di issue key (i Task collegati via
    "is implemented by"), invece di una chiamata per issue. Usato sia per
    la colonna Fix Version dei Documents sia per "Fix Version + Label" /
    "Components" del Release Report."""
    if not keys:
        return {}

    details: dict[str, dict] = {}
    unique_keys = sorted(set(keys))

    # "key in (...)" regge query molto lunghe, ma per sicurezza spezziamo
    # in blocchi da 100 chiavi.
    for i in range(0, len(unique_keys), 100):
        chunk = unique_keys[i : i + 100]
        jql = "key in (" + ", ".join(chunk) + ")"
        next_page_token: str | None = None
        while True:
            payload = {"jql": jql, "maxResults": 100, "fields": ["fixVersions", "labels", "components"]}
            if next_page_token:
                payload["nextPageToken"] = next_page_token
            response = client.post(f"{base_url}{SEARCH_PATH}", json=payload)
            response.raise_for_status()
            data = response.json()
            for raw in data.get("issues", []):
                f = raw.get("fields", {}) or {}
                versions = f.get("fixVersions") or []
                components = f.get("components") or []
                details[raw.get("key")] = {
                    "fix_version": ", ".join(v.get("name", "") for v in versions) or None,
                    "labels": ";".join(f.get("labels") or []) or None,
                    "components": ", ".join(c.get("name", "") for c in components) or None,
                }
            next_page_token = data.get("nextPageToken")
            if not next_page_token or data.get("isLast", True):
                break

    return details


def test_connection(base_url: str, email: str, api_token: str) -> str:
    """Verifica le credenziali con una chiamata leggera a Jira (GET
    /rest/api/3/myself, l'account autenticato) invece di lanciare una sync
    intera. Ritorna il nome visualizzato dell'account su successo, solleva
    JiraClientError con un messaggio presentabile in UI altrimenti."""
    if not (base_url and email and api_token):
        raise JiraClientError("Compila Jira base URL, email e API token prima di testare la connessione")

    try:
        with httpx.Client(auth=(email, api_token), timeout=15.0) as client:
            response = client.get(f"{base_url.rstrip('/')}/rest/api/3/myself")
            if response.status_code == 401:
                raise JiraClientError("Credenziali non valide: email o API token errati (o il token è scaduto)")
            response.raise_for_status()
            data = response.json()
            return data.get("displayName") or data.get("emailAddress") or email
    except httpx.HTTPError as exc:
        raise JiraClientError(f"Errore di comunicazione con Jira: {exc}") from exc


def count_issues_by_type(base_url: str, email: str, api_token: str, jql: str) -> dict[str, int]:
    """Conta le issue di una JQL per issuetype, senza costruire JiraIssue
    completi (niente changelog/task-detail per issue): usata per aggregati
    di sola conta come il grafico "Metriche" della Dashboard generale, dove
    servono solo i totali e recuperare 40+ changelog sarebbe inutilmente
    lento."""
    if not (base_url and email and api_token):
        raise JiraClientError(
            "Integrazione Jira non configurata: compila Jira base URL, email e API token "
            "nella sezione Configurazione"
        )

    base_url = base_url.rstrip("/")
    counts: dict[str, int] = {}
    next_page_token: str | None = None

    try:
        with httpx.Client(auth=(email, api_token), timeout=30.0) as client:
            while True:
                payload = {"jql": jql, "maxResults": 100, "fields": ["issuetype"]}
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
                    type_name = ((raw.get("fields") or {}).get("issuetype") or {}).get("name", "")
                    counts[type_name] = counts.get(type_name, 0) + 1

                next_page_token = data.get("nextPageToken")
                if not next_page_token or data.get("isLast", True):
                    break
    except httpx.HTTPError as exc:
        raise JiraClientError(f"Errore di comunicazione con Jira: {exc}") from exc

    return counts


def count_issues(base_url: str, email: str, api_token: str, jql: str) -> int:
    """Totale issue di una JQL, quando non serve il dettaglio per issuetype
    (es. una JQL che filtra gia' un solo issuetype)."""
    return sum(count_issues_by_type(base_url, email, api_token, jql).values())


# Account bot che apre e chiude automaticamente i Bug generati dallo scan di
# sicurezza (CVE su pacchetti/OS, vedi reporter delle issue): scoperto
# investigando perche' giugno 2026 avesse 35 Bug Done, quando 34 erano in
# realta' una chiusura massiva automatica dello stesso giorno, non lavoro di
# sviluppo. Usato per evidenziare questi Bug separatamente nei grafici.
CVE_BUG_REPORTER_EMAIL = "jira.security-pipeline@inpeco.com"


class CycleTimeIssue:
    def __init__(
        self,
        key: str,
        issue_type: str,
        actual_start: dt.date | None,
        actual_finish: dt.date | None,
        is_cve: bool = False,
    ):
        self.key = key
        self.issue_type = issue_type
        self.actual_start = actual_start
        self.actual_finish = actual_finish
        self.is_cve = is_cve


def fetch_cycle_times(base_url: str, email: str, api_token: str, jql: str) -> list[CycleTimeIssue]:
    """Come search_issues, ma solo issuetype/reporter + le date effettive dal
    changelog (niente description/task collegati/campi custom): usata dal
    grafico Cycle Time della Dashboard generale, dove serve solo la coppia
    (actual_start, actual_finish) per PBI, piu' il reporter per distinguere i
    Bug CVE del security-pipeline (vedi CVE_BUG_REPORTER_EMAIL)."""
    if not (base_url and email and api_token):
        raise JiraClientError(
            "Integrazione Jira non configurata: compila Jira base URL, email e API token "
            "nella sezione Configurazione"
        )

    base_url = base_url.rstrip("/")
    results: list[CycleTimeIssue] = []
    next_page_token: str | None = None

    try:
        with httpx.Client(auth=(email, api_token), timeout=30.0) as client:
            while True:
                payload = {"jql": jql, "maxResults": 100, "fields": ["issuetype", "reporter"]}
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
                    key = raw.get("key", "")
                    fields = raw.get("fields") or {}
                    issue_type = (fields.get("issuetype") or {}).get("name", "")
                    reporter_email = (fields.get("reporter") or {}).get("emailAddress")
                    is_cve = issue_type == "Bug" and reporter_email == CVE_BUG_REPORTER_EMAIL
                    actual_start, actual_finish = _fetch_status_dates(client, base_url, key, issue_type)
                    results.append(CycleTimeIssue(key, issue_type, actual_start, actual_finish, is_cve))

                next_page_token = data.get("nextPageToken")
                if not next_page_token or data.get("isLast", True):
                    break
    except httpx.HTTPError as exc:
        raise JiraClientError(f"Errore di comunicazione con Jira: {exc}") from exc

    return results


def search_issues(base_url: str, email: str, api_token: str, jql: str) -> list[JiraIssue]:
    if not (base_url and email and api_token):
        raise JiraClientError(
            "Integrazione Jira non configurata: compila Jira base URL, email e API token "
            "nella sezione Configurazione"
        )

    base_url = base_url.rstrip("/")
    auth = (email, api_token)
    # customfield_10130 = "Change Description", usato per i Bug al posto
    # della description standard nei documenti generati.
    CHANGE_DESCRIPTION_FIELD = "customfield_10130"
    # customfield_10129 = "Problem Cause", usato nel Release Report generato.
    PROBLEM_CAUSE_FIELD = "customfield_10129"
    # customfield_10146 = "Developer Effort" (solo Story), colonna "Ore
    # stimate" del Backlog.
    DEV_EFFORT_FIELD = "customfield_10146"
    fields = [
        "summary",
        "issuetype",
        "status",
        "labels",
        "timetracking",
        "parent",
        "issuelinks",
        "description",
        "components",
        CHANGE_DESCRIPTION_FIELD,
        PROBLEM_CAUSE_FIELD,
        DEV_EFFORT_FIELD,
    ]

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
                    implemented_by = _extract_implemented_by(f.get("issuelinks") or [])
                    components = ", ".join(c.get("name", "") for c in (f.get("components") or [])) or None
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
                            implemented_by=implemented_by,
                            description=_extract_description(f.get("description")),
                            change_description=_extract_description(f.get(CHANGE_DESCRIPTION_FIELD)),
                            problem_cause=_extract_description(f.get(PROBLEM_CAUSE_FIELD)),
                            components=components,
                            dev_effort_hours=f.get(DEV_EFFORT_FIELD),
                        )
                    )

                next_page_token = data.get("nextPageToken")
                if not next_page_token or data.get("isLast", True):
                    break

            # Una sola query batch per fix version/labels/components di tutti
            # i Task collegati trovati, invece di una chiamata per task.
            all_task_keys = [t["key"] for issue in issues for t in issue.implemented_by if t.get("key")]
            task_details = _fetch_task_details(client, base_url, all_task_keys)
            for issue in issues:
                for task in issue.implemented_by:
                    details = task_details.get(task["key"], {})
                    task["fix_version"] = details.get("fix_version")
                    task["labels"] = details.get("labels")
                    task["components"] = details.get("components")
    except httpx.HTTPError as exc:
        raise JiraClientError(f"Errore di comunicazione con Jira: {exc}") from exc

    return issues
