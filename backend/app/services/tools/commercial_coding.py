"""Legge i ticket di Commercial Coding (di default la lista "Tickets" del
sito SharePoint Development; il link alla lista e' un'impostazione
personale) creati dall'utente collegato al browser dell'app, senza
finestra (headless), col profilo del browser dell'automazione del CO e il
suo accesso Microsoft. Usa le API REST di SharePoint dalla pagina della
lista (stessa sessione), non la tabella a video: niente colonne nascoste o
righe caricate a scorrimento.

    python -m app.services.tools.commercial_coding

Su stdin un JSON {"list_url": ...} (vuoto = la lista predefinita). Stampa righe "PROGRESS <fatti> <totale>" e, sull'ultima riga, un JSON
{"tickets": [...], "account": ..., "error": ...} (account = email
dell'utente Microsoft con cui si e' letto) letto da
routers/tools_commercial_coding.py. Codici di uscita: 0 letto, 2 login da
rifare, 1 altro errore. Non scrive nel database.
"""

import json
import os
import sys
import time
import urllib.parse

from playwright.sync_api import sync_playwright

from app.services.tools.change_order_browser import PROFILE_DIR
from app.services.tools.purchase_requisitions import _answer_microsoft_prompts

DEFAULT_LIST_URL = "https://inpeco.sharepoint.com/sites/Development/Lists/Tickets/AllItems.aspx"
LOGIN_TIMEOUT_S = 90


def parse_list_url(url: str) -> tuple[str, str]:
    """Da un link a una lista SharePoint (una vista qualsiasi, anche con i
    filtri, es. ".../sites/Development/Lists/Tickets/AllItems.aspx?Filter...")
    il sito ("https://….sharepoint.com/sites/Development") e il percorso
    della lista ("/sites/Development/Lists/Tickets"). ValueError se non e'
    il link di una lista. I filtri del link non contano: si leggono sempre i
    ticket dell'utente collegato."""
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme != "https" or not parts.netloc.endswith(".sharepoint.com"):
        raise ValueError("non è un indirizzo https di SharePoint")
    path = urllib.parse.unquote(parts.path)
    site, sep, rest = path.partition("/Lists/")
    name = rest.split("/")[0]
    if not sep or not name:
        raise ValueError("non è il link di una lista (manca /Lists/…)")
    origin = f"{parts.scheme}://{parts.netloc}"
    return origin + site, f"{site}/Lists/{name}"


def item_url(list_url: str, item_id: int) -> str:
    """Pagina di un elemento della lista."""
    site, list_path = parse_list_url(list_url)
    origin = site[: len(site) - len(list_path.split("/Lists/")[0])]
    return f"{origin}{urllib.parse.quote(list_path)}/DispForm.aspx?ID={item_id}"

# Colonne della lista (nome interno) lette per ogni ticket. Owner e' la
# colonna "Agent" (chi gestisce il ticket), family una lookup.
FIELDS = [
    "ID",
    "Created",
    "Modified",
    "description",
    "vendor",
    "vendorCode",
    "OData__x0033_dModel",
    "minTemp",
    "maxTemp",
    "humidity",
    "altitude",
    "MinStorageTemperature",
    "MaxStorageTemperature",
    "MinStorageHumidity",
    "MaxStorageHumidity",
    "changeReason",
    "certificationTicket",
    "department",
    "Status",
    "finalCoding",
    "Attachments",
]

# Utente collegato e suoi ticket (Author = lui), a pagine di 500. Si
# chiedono solo le colonne che la lista ha (un'altra lista puo' non averle
# tutte: SharePoint rifiuterebbe la richiesta).
FETCH_JS = """async ({site, list, fields, lookups}) => {
  const headers = {Accept: 'application/json;odata=nometadata'}
  const get = async (url) => {
    const r = await fetch(url, {headers, credentials: 'include'})
    if (!r.ok) throw new Error(`SharePoint ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return r.json()
  }
  const me = await get(`${site}/_api/web/currentuser?$select=Id,Title,Email`)
  const api = `${site}/_api/web/GetList('${encodeURIComponent(list.replace(/'/g, "''"))}')`
  const names = new Set((await get(`${api}/fields?$select=InternalName`)).value.map(f => f.InternalName))
  const has = n => names.has(n) || names.has(n.replace(/^OData_/, ''))
  const select = [...fields.filter(has), ...['Author', ...lookups.filter(has)].map(n => `${n}/Title`)].join(',')
  const expand = ['Author', ...lookups.filter(has)].join(',')
  let url = `${api}/items?$top=500&$orderby=ID desc&$filter=AuthorId eq ${me.Id}&$select=${select}&$expand=${expand}`
  const items = []
  while (url) {
    const page = await get(url)
    items.push(...page.value)
    url = page['odata.nextLink'] || null
  }
  return {me, items}
}"""


class LoginRequired(Exception):
    pass


def _progress(done: int, total: int) -> None:
    print(f"PROGRESS {done} {total}", flush=True)


def _open_list(page, list_url: str, site: str) -> None:
    """Apre la lista; il login Microsoft col profilo salvato va da solo
    (risponde alle schermate intermedie). LoginRequired se resta fermo."""
    page.goto(list_url)
    start = time.monotonic()
    while time.monotonic() - start < LOGIN_TIMEOUT_S:
        if urllib.parse.unquote(page.url).lower().startswith(site.lower()):
            page.wait_for_load_state("domcontentloaded")
            return
        _answer_microsoft_prompts(page)
        page.wait_for_timeout(500)
    raise LoginRequired(page.url)


def _name(value) -> str | None:
    return (value or {}).get("Title") if isinstance(value, dict) else None


def _text(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _ticket(item: dict) -> dict:
    return {
        "item_id": item["ID"],
        "created_at": item.get("Created"),
        "modified_at": item.get("Modified"),
        "description": _text(item.get("description")),
        "vendor": _text(item.get("vendor")),
        "vendor_code": _text(item.get("vendorCode")),
        "family": _name(item.get("family")),
        "status": _text(item.get("Status")),
        "final_coding": _text(item.get("finalCoding")),
        "change_reason": _text(item.get("changeReason")),
        "certification_ticket": _text(item.get("certificationTicket")),
        "department": _text(item.get("department")),
        "agent": _name(item.get("Owner")),
        "author": _name(item.get("Author")),
        "has_attachments": bool(item.get("Attachments")),
        # Dati tecnici dell'articolo, come nella lista: {etichetta: valore}.
        "details": {
            "3D Model": _text(item.get("OData__x0033_dModel")),
            "Min Working Temperature": _text(item.get("minTemp")),
            "Max Working Temperature": _text(item.get("maxTemp")),
            "Max Working Humidity": _text(item.get("humidity")),
            "Max Working Altitude": _text(item.get("altitude")),
            "Min Storage Temperature": _text(item.get("MinStorageTemperature")),
            "Max Storage Temperature": _text(item.get("MaxStorageTemperature")),
            "Min Storage Humidity": _text(item.get("MinStorageHumidity")),
            "Max Storage Humidity": _text(item.get("MaxStorageHumidity")),
        },
    }


def fetch_tickets(list_url: str) -> tuple[list[dict], str | None]:
    site, list_path = parse_list_url(list_url)
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel=os.environ.get("CO_BROWSER_CHANNEL", "chrome"), headless=True
        )
        try:
            page = context.new_page()
            _progress(0, 0)
            _open_list(page, list_url, site)
            result = page.evaluate(
                FETCH_JS, {"site": site, "list": list_path, "fields": FIELDS, "lookups": ["Owner", "family"]}
            )
            tickets = [_ticket(item) for item in result["items"]]
            _progress(len(tickets), len(tickets))
            return tickets, (result["me"] or {}).get("Email")
        finally:
            context.close()


def main() -> int:
    request = json.loads(sys.stdin.read() or "{}")
    list_url = (request.get("list_url") or "").strip() or DEFAULT_LIST_URL
    try:
        tickets, account = fetch_tickets(list_url)
    except LoginRequired:
        print(json.dumps({"tickets": [], "account": None, "error": "login"}))
        return 2
    except Exception as exc:
        message = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
        print(json.dumps({"tickets": [], "account": None, "error": message}))
        return 1
    print(json.dumps({"tickets": tickets, "account": account, "error": None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
