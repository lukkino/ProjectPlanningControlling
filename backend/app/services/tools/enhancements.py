"""Legge gli Enhancement (Opportunity) di una list view di Salesforce (di
default "Enhancement ProTube"; il link alla vista e' un'impostazione
personale), senza finestra (headless), col profilo del browser
dell'automazione del CO: il login si fa da solo come per i Case dei
complaint (vedi salesforce_cases.py).

La list view non si legge pagina per pagina: l'API REST ne restituisce la
query SOQL (filtri e ordinamento della vista), che qui si riusa chiedendo i
campi che servono al tool. Cosi' cambiando i filtri della vista in
Salesforce cambia anche cio' che legge il tool.

Il campo con l'ID Jira dell'enhancement si cerca tra i campi delle
Opportunity (nome o etichetta con "jira"): finche' non esiste, l'ID resta
vuoto; appena viene creato in Salesforce si legge senza cambiare il codice.

    python -m app.services.tools.enhancements

Su stdin un JSON {"list_url": ...} (vuoto = la vista predefinita). Stampa
sull'ultima riga un JSON {"enhancements": [...], "jira_field": ..., "view":
..., "error": ...} (ASCII). Codici di uscita: 0 letto, 2 login da rifare, 1
altro errore. Non scrive nel database e non modifica niente in Salesforce.
"""

import json
import os
import re
import sys
import urllib.parse

from playwright.sync_api import sync_playwright

from app.services.tools.change_order_browser import PROFILE_DIR
from app.services.tools.salesforce_cases import API_VERSION, SALESFORCE_URL, LoginRequired, _login

DEFAULT_LIST_URL = "https://inpeco-force.lightning.force.com/lightning/o/Opportunity/list?filterName=Enhancement_ProTube"
LIGHTNING_URL = "https://inpeco-force.lightning.force.com"

# Campi letti (chiave nel risultato -> campo Salesforce); quelli che
# l'oggetto non ha si saltano. Le picklist con toLabel: l'etichetta, non il
# valore API.
FIELDS = {
    "request_id": "Request_Id__c",
    "name": "Name",
    "stage": "StageName",
    "priority": "Priority__c",
    "enhancement_type": "Enhancement_Type__c",
    "source": "EnhancementSource__c",
    "product_line": "Product_Line_Enhancement__c",
    "target_release": "TargetRelease__c",
    "expected_due_date": "ExpectedDueDate__c",
    "release_date": "Release_Date__c",
    "short_description": "Short_Description__c",
    "accounts": "Accounts_Concat__c",
    "cases": "Cases_Concat__c",
    "is_closed": "IsClosed",
    "created_at": "CreatedDate",
    "modified_at": "LastModifiedDate",
}
LOOKUPS = {"owner": "Owner.Name", "created_by": "CreatedBy.Name"}
PICKLIST_TYPES = {"picklist", "multipicklist"}


def parse_list_url(url: str) -> tuple[str, str]:
    """Da un link a una list view di Salesforce Lightning (es.
    ".../lightning/o/Opportunity/list?filterName=Enhancement_ProTube")
    l'oggetto e la vista (nome API o Id). ValueError se non lo e'."""
    parts = urllib.parse.urlsplit(url.strip())
    host = parts.netloc.lower()
    if parts.scheme != "https" or not (host.endswith(".force.com") or host.endswith(".salesforce.com")):
        raise ValueError("non è un indirizzo https di Salesforce")
    match = re.match(r"^/lightning/o/(\w+)/list/?$", parts.path)
    view = (urllib.parse.parse_qs(parts.query).get("filterName") or [""])[0].strip()
    if not match or not view:
        raise ValueError("non è il link di una list view (manca /lightning/o/…/list?filterName=…)")
    if match.group(1) != "Opportunity":
        raise ValueError(f"la vista è di {match.group(1)}, non di Opportunity")
    return match.group(1), view


def record_url(sf_id: str) -> str:
    return f"{LIGHTNING_URL}/lightning/r/Opportunity/{sf_id}/view"


def _get(context, headers: dict, path: str) -> dict:
    response = context.request.get(f"{SALESFORCE_URL}/services/data/{API_VERSION}{path}", headers=headers)
    if response.status == 401:
        raise LoginRequired("sessione non valida")
    if response.status != 200:
        raise RuntimeError(f"Salesforce ha risposto {response.status}: {response.text()[:200]}")
    return response.json()


def _view(context, headers: dict, sobject: str, view: str) -> dict:
    """La list view per nome API (DeveloperName) o Id."""
    path = f"/sobjects/{sobject}/listviews"
    while path:
        body = _get(context, headers, path)
        for v in body.get("listviews", []):
            if view in (v.get("developerName"), v.get("id"), (v.get("id") or "")[:15]):
                return v
        next_url = body.get("nextRecordsUrl")
        path = next_url.split(f"/services/data/{API_VERSION}", 1)[-1] if next_url else None
    raise RuntimeError(f"list view {view} non trovata (o non visibile all'utente del browser)")


def _value(record: dict, path: str):
    value = record
    for part in path.split("."):
        value = (value or {}).get(part)
    return value


def fetch_enhancements(list_url: str) -> tuple[list[dict], str | None, str]:
    sobject, view_name = parse_list_url(list_url)
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel=os.environ.get("CO_BROWSER_CHANNEL", "chrome"), headless=True
        )
        try:
            headers = {"Authorization": f"Bearer {_login(context)}"}
            print("PROGRESS 1 3", flush=True)
            view = _view(context, headers, sobject, view_name)
            query = _get(context, headers, f"/sobjects/{sobject}/listviews/{view['id']}/describe")["query"]
            described = {f["name"]: f for f in _get(context, headers, f"/sobjects/{sobject}/describe")["fields"]}
            jira_field = next(
                (n for n, f in described.items() if "jira" in (n + " " + (f.get("label") or "")).lower()), None
            )
            fields = {key: name for key, name in FIELDS.items() if name in described}
            if jira_field:
                fields["jira_key"] = jira_field

            def select_item(name: str) -> str:
                return f"toLabel({name})" if described[name].get("type") in PICKLIST_TYPES else name

            select = ", ".join(["Id", *(select_item(n) for n in fields.values()), *LOOKUPS.values()])
            # Stessi filtri e ordinamento della vista, con i campi del tool.
            match = re.match(r"^\s*SELECT\s.+?\sFROM\s+(\w+)\b(.*)$", query, flags=re.IGNORECASE | re.DOTALL)
            if not match:
                raise RuntimeError("query della list view non riconosciuta")
            soql = f"SELECT {select} FROM {match.group(1)}{match.group(2)}"
            print("PROGRESS 2 3", flush=True)
            records: list[dict] = []
            path = f"/query?q={urllib.parse.quote(soql)}"
            while path:
                body = _get(context, headers, path)
                for r in body.get("records", []):
                    row = {"sf_id": r["Id"]}
                    row.update({key: r.get(name) for key, name in fields.items()})
                    row.update({key: _value(r, name) for key, name in LOOKUPS.items()})
                    records.append(row)
                next_url = body.get("nextRecordsUrl")
                path = next_url.split(f"/services/data/{API_VERSION}", 1)[-1] if next_url else None
            print("PROGRESS 3 3", flush=True)
            label = view.get("label") or view_name
            return records, jira_field, label
        finally:
            context.close()


def main() -> int:
    request = json.loads(sys.stdin.read() or "{}")
    list_url = (request.get("list_url") or "").strip() or DEFAULT_LIST_URL
    try:
        records, jira_field, view = fetch_enhancements(list_url)
    except LoginRequired:
        print(json.dumps({"enhancements": [], "error": "login"}))
        return 2
    except Exception as exc:
        message = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
        print(json.dumps({"enhancements": [], "error": message}))
        return 1
    print(json.dumps({"enhancements": records, "jira_field": jira_field, "view": view, "error": None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
