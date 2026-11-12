"""Legge i Case dei complaint da Salesforce, senza finestra (headless), col
profilo del browser dell'automazione del CO: il login si fa da solo col
pulsante "Log in with AzureSSO" e l'accesso Microsoft salvato nel profilo.
Con la sessione del browser interroga l'API REST di Salesforce (una query per
blocco di valori, non una pagina per Case).

    python -m app.services.tools.salesforce_cases < richiesta.json

Legge da stdin un JSON {"ids": [...], "jira_keys": [...], "case_numbers":
[...], "scope": {"product_line", "case_level", "since"}} e stampa sull'ultima
riga un JSON {"records": [...], "scope_records": [...], "error": ...} letto
da routers/complaints.py. "scope" (facoltativo) chiede anche tutti i Case di
quella linea di prodotto e livello creati da "since" in poi, per trovare i
Case senza complaint. Codici di uscita: 0 letto, 2 login da
rifare, 1 altro errore. Non scrive nel database.
"""

import json
import os
import sys
import time
import urllib.parse

from playwright.sync_api import sync_playwright

from app.services.tools.change_order_browser import PROFILE_DIR

SALESFORCE_URL = "https://inpeco-force.my.salesforce.com"
API_VERSION = "v60.0"
# Campi letti per ogni Case (Account.Name = cliente/sito).
FIELDS = [
    "Id",
    "CaseNumber",
    "JiraID__c",
    "Status",
    "IsClosed",
    "Account.Name",
    "Inpeco_Priority__c",
    "Partner_Priority__c",
    "Safety__c",
    "Severity__c",
    "CreatedDate",
]
# Valori per query: la query va nell'URL, che non puo' essere troppo lungo.
CHUNK = 80
LOGIN_TIMEOUT_S = 60


class LoginRequired(Exception):
    pass


def _session_id(context) -> str | None:
    return next(
        (c["value"] for c in context.cookies() if c["name"] == "sid" and "my.salesforce.com" in c["domain"]),
        None,
    )


def _login(context) -> str:
    """Apre Salesforce e, se serve, clicca "Log in with AzureSSO": con
    l'accesso Microsoft gia' nel profilo il login finisce da solo."""
    page = context.new_page()
    page.goto(f"{SALESFORCE_URL}/lightning/page/home")
    start = time.monotonic()
    while time.monotonic() - start < LOGIN_TIMEOUT_S:
        sid = _session_id(context)
        if sid:
            return sid
        sso = page.get_by_role("button", name="Log in with AzureSSO")
        try:
            if sso.count() and sso.first.is_visible():
                sso.first.click()
        except Exception:
            pass
        page.wait_for_timeout(500)
    raise LoginRequired(page.url)


def _quote(values: list[str]) -> str:
    return ",".join("'" + v.replace("\\", "").replace("'", "") + "'" for v in values)


def _record(record: dict) -> dict:
    return {
        "id": record["Id"],
        "case_number": record.get("CaseNumber"),
        "jira_key": record.get("JiraID__c"),
        "status": record.get("Status"),
        "is_closed": record.get("IsClosed"),
        "account": (record.get("Account") or {}).get("Name"),
        "inpeco_priority": record.get("Inpeco_Priority__c"),
        "customer_impact": record.get("Partner_Priority__c"),
        "safety": record.get("Safety__c"),
        "severity": record.get("Severity__c"),
        "created": (record.get("CreatedDate") or "")[:10] or None,
    }


def _query(context, headers: dict, soql: str) -> list[dict]:
    """Tutti i record della query (seguendo le pagine di Salesforce)."""
    url = f"{SALESFORCE_URL}/services/data/{API_VERSION}/query?q={urllib.parse.quote(soql)}"
    records: list[dict] = []
    while url:
        response = context.request.get(url, headers=headers)
        if response.status == 401:
            raise LoginRequired("sessione non valida")
        if response.status != 200:
            raise RuntimeError(f"Salesforce ha risposto {response.status}: {response.text()[:200]}")
        body = response.json()
        records.extend(_record(r) for r in body.get("records", []))
        next_url = body.get("nextRecordsUrl")
        url = f"{SALESFORCE_URL}{next_url}" if next_url else None
    return records


def fetch_cases(
    ids: list[str], jira_keys: list[str], case_numbers: list[str], scope: dict | None = None
) -> tuple[list[dict], list[dict]]:
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel=os.environ.get("CO_BROWSER_CHANNEL", "chrome"), headless=True
        )
        try:
            sid = _login(context)
            headers = {"Authorization": f"Bearer {sid}"}
            records: dict[str, dict] = {}
            for field, values in (("Id", ids), ("JiraID__c", jira_keys), ("CaseNumber", case_numbers)):
                values = sorted({v for v in values if v})
                for i in range(0, len(values), CHUNK):
                    soql = f"SELECT {', '.join(FIELDS)} FROM Case WHERE {field} IN ({_quote(values[i:i + CHUNK])})"
                    for record in _query(context, headers, soql):
                        records[record["id"]] = record
            scope_records: list[dict] = []
            if scope:
                since = str(scope.get("since") or "2000-01-01")[:10]
                soql = (
                    f"SELECT {', '.join(FIELDS)} FROM Case"
                    f" WHERE AffectedProductLine__c IN ({_quote([scope['product_line']])})"
                    f" AND CaseLevel__c IN ({_quote([scope['case_level']])})"
                    f" AND CreatedDate >= {since}T00:00:00Z"
                )
                scope_records = _query(context, headers, soql)
            return list(records.values()), scope_records
        finally:
            context.close()


def main() -> int:
    request = json.loads(sys.stdin.read() or "{}")
    try:
        records, scope_records = fetch_cases(
            request.get("ids", []), request.get("jira_keys", []), request.get("case_numbers", []), request.get("scope")
        )
    except LoginRequired:
        print(json.dumps({"records": [], "scope_records": [], "error": "login"}))
        return 2
    except Exception as exc:
        message = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
        print(json.dumps({"records": [], "scope_records": [], "error": message}))
        return 1
    print(json.dumps({"records": records, "scope_records": scope_records, "error": None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
