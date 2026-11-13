"""Legge le RDA (richieste di acquisto) preparate dall'utente in Dynamics 365
Finance and Operations, senza finestra (headless), col profilo del browser
dell'automazione del CO: l'accesso Microsoft salvato nel profilo basta, il
login si fa da solo.

Il preparatore si ricava dalla pagina "Richieste di acquisto preparate
dall'utente" (prima RDA dell'elenco); poi, con la sessione del browser, si
interrogano le entita' OData di Dynamics: testate (PurchaseRequisitionHeaders),
righe (PurchaseRequisitionLines) e nomi dei fornitori (VendorsV2).

    python -m app.services.tools.purchase_requisitions < richiesta.json

Legge da stdin un JSON {"list_url": ...}: il link all'elenco delle RDA
preparate dall'utente (ambiente Dynamics e societa'), configurabile per
utente; senza, quello predefinito. Stampa righe "PROGRESS <fatti> <totale>"
e, sull'ultima riga, un JSON {"requisitions": [...], "account": ...,
"error": ...} (account = utente Microsoft con cui si e' letto) letto da
routers/tools_purchase_requisitions.py. Codici di uscita: 0 letto, 2 login
da rifare, 1 altro errore. Non scrive nel database ne' in Dynamics.
"""

import json
import os
import re
import sys
import time
import urllib.parse

from playwright.sync_api import sync_playwright

from app.services.tools.change_order_browser import PROFILE_DIR

DEFAULT_LIST_URL = "https://inpeco.operations.dynamics.com/?cmp=ISP&mi=PurchReqPreparedByMe"
LOGIN_TIMEOUT_S = 90
# Elenco ancora vuoto dopo questo tempo (login gia' fatto): nessuna RDA.
EMPTY_LIST_AFTER_S = 45
# Valori per filtro OData: il filtro va nell'URL, che non puo' essere troppo lungo.
CHUNK = 30

LINE_FIELDS = [
    "RequisitionNumber",
    "RequisitionLineNumber",
    "LineStatus",
    "ProductName",
    "LineDescription",
    "ItemNumber",
    "ProcurementProductCategoryName",
    "RequestedPurchaseQuantity",
    "PurchaseUnitSymbol",
    "PurchasePrice",
    "LineAmount",
    "CurrencyCode",
    "VendorAccountNumber",
    "ProjectId",
    "BuyingLegalEntityId",
    "RequestedDate",
    "BusinessJustificationDetails",
]


class LoginRequired(Exception):
    pass


def _progress(done: int, total: int) -> None:
    print(f"PROGRESS {done} {total}", flush=True)


def _date(value: str | None) -> str | None:
    """"2025-08-29T12:00:00Z" -> "2025-08-29"; la data "vuota" di Dynamics
    (1900-01-01) diventa None."""
    if not value or value.startswith("1900-01-01"):
        return None
    return value[:10]


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _get(context, base_url: str, path: str) -> list[dict]:
    """Tutti i record di una query OData (seguendo @odata.nextLink)."""
    url = f"{base_url}{path}"
    records: list[dict] = []
    while url:
        response = context.request.get(url, headers={"Accept": "application/json"})
        if response.status in (401, 302):
            raise LoginRequired("sessione non valida")
        if response.status != 200:
            raise RuntimeError(f"Dynamics ha risposto {response.status}: {response.text()[:200]}")
        body = response.json()
        records.extend(body.get("value", []))
        url = body.get("@odata.nextLink")
    return records


def _query(entity: str, filter_: str, select: list[str] | None = None) -> str:
    params = {"cross-company": "true", "$filter": filter_}
    if select:
        params["$select"] = ",".join(select)
    return f"/data/{entity}?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}"


def _answer_microsoft_prompts(page) -> None:
    """Schermate intermedie del login Microsoft con l'account gia' salvato
    nel profilo: "Scegli un account" (si clicca l'account) e "Rimanere
    connesso?" (Si'). Se serve la password il login resta fermo e scade:
    LoginRequired."""
    try:
        tile = page.locator("#tilesHolder [data-test-id], #tilesHolder .table[role=button]")
        if tile.count() and tile.first.is_visible():
            tile.first.click()
            return
        stay = page.locator("#idSIButton9")
        if page.locator("#KmsiDescription, #KmsiCheckboxField").count() and stay.is_visible():
            stay.click()
    except Exception:
        pass


def _account(page) -> str | None:
    """Utente Microsoft collegato a Dynamics (l'email nella barra in alto)."""
    try:
        return page.evaluate(
            """() => [...document.querySelectorAll('[title]')].map(e => e.getAttribute('title'))
              .find(t => /^[^\\s@]+@[^\\s@]+\\.[a-z]+$/i.test(t || '')) || null"""
        )
    except Exception:
        return None


def _first_requisition_number(page, list_url: str) -> str | None:
    """Apre l'elenco "preparate dall'utente" (login automatico col profilo) e
    legge il numero della prima RDA."""
    host = urllib.parse.urlsplit(list_url).netloc
    page.goto(list_url)
    start = time.monotonic()
    while time.monotonic() - start < LOGIN_TIMEOUT_S:
        if host and host in page.url:
            try:
                number = page.evaluate(
                    "() => (document.querySelector('input[aria-label=\"Richiesta di acquisto\"]') || {}).value || null"
                )
            except Exception:
                # Pagina in navigazione (redirect del login, caricamento del
                # client di Dynamics): si riprova al giro dopo.
                number = None
            if number:
                return number
            # In Dynamics da un pezzo ma l'elenco resta vuoto: nessuna RDA.
            if time.monotonic() - start > EMPTY_LIST_AFTER_S:
                return None
        elif "login.microsoftonline.com" in page.url:
            _answer_microsoft_prompts(page)
        page.wait_for_timeout(1000)
    raise LoginRequired(page.url)


# Stati delle RDA con un flusso di approvazione ancora in corso: per queste
# si legge l'ultima azione dal menu "Flusso di lavoro" (una lettura a RDA).
OPEN_WORKFLOW_STATUSES = {"InReview", "Approved"}
NUMBER_INPUT = 'input[aria-label="Richiesta di acquisto"]'
# Velo di attesa di Dynamics: finche' c'e', i clic non arrivano.
SHELL_IDLE_JS = (
    "() => { const b = document.getElementById('ShellBlockingDiv');"
    " return !b || getComputedStyle(b).display === 'none' || b.offsetParent === null }"
)
_LAST_ACTION_RE = re.compile(r"Ultima azione eseguita:\s*(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s+Utente:\s*([^\]]+)\]")


def _approvers(context, base_url: str, numbers: list[str]) -> dict[str, list[dict]]:
    """Approvatori del flusso di ogni RDA con il loro stato (Pending = la
    RDA e' in carico a loro, Completed = gia' approvato)."""
    result: dict[str, list[dict]] = {}
    for i in range(0, len(numbers), CHUNK):
        filter_ = " or ".join(f"RequisitionNumber eq {_quote(n)}" for n in numbers[i:i + CHUNK])
        for row in _get(context, base_url, _query("UbuyRequisitionWorkflowApprovers", filter_)):
            entry = {"name": (row.get("PersonName") or "").strip(), "status": row.get("RequisitionWorkflowApproverStatus")}
            if entry["name"] and entry not in result.setdefault(row["RequisitionNumber"], []):
                result[row["RequisitionNumber"]].append(entry)
    return result


def _last_action(page, number: str) -> dict | None:
    """Ultima azione del flusso di lavoro della RDA, dal menu "Flusso di
    lavoro" della pagina elenco (agisce sulla riga selezionata): la si filtra
    col campo Filtro, la si seleziona e si apre il menu."""
    page.wait_for_function(SHELL_IDLE_JS, timeout=20000)
    box = page.locator('input[aria-label="Filtro"]').first
    box.click()
    box.fill(number)
    box.press("Enter")
    page.wait_for_function(
        "n => { const c = [...document.querySelectorAll('input[aria-label=\"Richiesta di acquisto\"]')];"
        " return c.length === 1 && c[0].value === n }",
        arg=number,
        timeout=20000,
    )
    page.wait_for_function(SHELL_IDLE_JS, timeout=20000)
    # Si seleziona la riga cliccando il Nome: il numero e' un link (aprirebbe
    # la RDA) e a volte risulta coperto.
    row_cell = page.locator('input[aria-label="Nome"]').first
    if row_cell.count():
        row_cell.click(force=True)
    else:
        page.locator(f'{NUMBER_INPUT}[value="{number}"]').first.click(force=True)
    page.wait_for_function(SHELL_IDLE_JS, timeout=20000)
    page.wait_for_timeout(400)
    page.locator('button[data-dyn-controlname$="WorkflowDropDialog"]').first.click()
    page.wait_for_function(
        "() => [...document.querySelectorAll('*')].some(e => e.childElementCount === 0 && /Ultima azione/.test(e.textContent))",
        timeout=20000,
    )
    text = page.evaluate(
        "() => [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0"
        " && /Ultima azione/.test(e.textContent)).map(e => e.textContent)[0] || ''"
    )
    page.keyboard.press("Escape")
    match = _LAST_ACTION_RE.search(text)
    if not match:
        return None
    day, month, year, hour, minute, user = match.groups()
    return {"at": f"{year}-{int(month):02d}-{int(day):02d}T{int(hour):02d}:{minute}", "by": user.strip()}


def fetch_requisitions(list_url: str) -> tuple[list[dict], str | None]:
    parts = urllib.parse.urlsplit(list_url)
    base_url = f"{parts.scheme}://{parts.netloc}"
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel=os.environ.get("CO_BROWSER_CHANNEL", "chrome"), headless=True
        )
        try:
            page = context.new_page()
            _progress(0, 0)
            first = _first_requisition_number(page, list_url)
            account = _account(page)
            if not first:
                return [], account
            header = _get(context, base_url, _query("PurchaseRequisitionHeaders", f"RequisitionNumber eq {_quote(first)}"))
            if not header:
                raise RuntimeError(f"RDA {first} non trovata nei dati di Dynamics")
            preparer = header[0]["PreparerPersonnelNumber"]
            headers = _get(
                context, base_url, _query("PurchaseRequisitionHeaders", f"PreparerPersonnelNumber eq {_quote(preparer)}")
            )
            numbers = sorted({h["RequisitionNumber"] for h in headers})
            total = len(numbers)
            _progress(0, total)

            lines: dict[str, list[dict]] = {}
            for i in range(0, total, CHUNK):
                chunk = numbers[i:i + CHUNK]
                filter_ = " or ".join(f"RequisitionNumber eq {_quote(n)}" for n in chunk)
                for line in _get(context, base_url, _query("PurchaseRequisitionLines", filter_, LINE_FIELDS)):
                    lines.setdefault(line["RequisitionNumber"], []).append(line)
                _progress(min(i + CHUNK, total), total)

            # Nomi dei fornitori (best effort: senza permesso resta il codice).
            vendors: dict[str, str] = {}
            accounts = sorted({l["VendorAccountNumber"] for ls in lines.values() for l in ls if l.get("VendorAccountNumber")})
            try:
                for i in range(0, len(accounts), CHUNK):
                    filter_ = " or ".join(f"VendorAccountNumber eq {_quote(a)}" for a in accounts[i:i + CHUNK])
                    for v in _get(context, base_url, _query("VendorsV2", filter_, ["VendorAccountNumber", "VendorOrganizationName"])):
                        vendors[v["VendorAccountNumber"]] = v.get("VendorOrganizationName") or ""
            except RuntimeError:
                pass

            # Flusso di approvazione: in carico a chi (API) e ultima azione
            # (dalla pagina, solo per le RDA con il flusso in corso). Best
            # effort: senza, restano vuoti.
            try:
                approvers = _approvers(context, base_url, numbers)
            except RuntimeError:
                approvers = {}
            open_numbers = sorted(h["RequisitionNumber"] for h in headers if h.get("RequisitionStatus") in OPEN_WORKFLOW_STATUSES)
            last_actions: dict[str, dict | None] = {}
            for done, number in enumerate(open_numbers, start=1):
                try:
                    last_actions[number] = _last_action(page, number)
                except Exception:
                    last_actions[number] = None
                    page.keyboard.press("Escape")
                _progress(done, len(open_numbers))

            result = []
            for h in headers:
                number = h["RequisitionNumber"]
                req_lines = sorted(lines.get(number, []), key=lambda l: l.get("RequisitionLineNumber") or 0)
                result.append(
                    {
                        "number": number,
                        "name": h.get("RequisitionName") or None,
                        "status": h.get("RequisitionStatus") or None,
                        "project_id": h.get("DefaultProjectId") or None,
                        "legal_entity": h.get("ProjectBuyingLegalEntityId") or None,
                        "purpose": h.get("RequisitionPurpose") or None,
                        "justification_code": h.get("DefaultBusinessJustificationCode") or None,
                        "justification": h.get("DefaultBusinessJustificationDetails") or None,
                        "date": _date(h.get("DefaultAccountingDate")),
                        "requested_date": _date(h.get("DefaultRequestedDate")),
                        "on_hold": h.get("IsPurchaseRequisitionOnHold") == "Yes",
                        "on_hold_explanation": h.get("OnHoldExplanation") or None,
                        "approvers": approvers.get(number, []),
                        "in_charge": [a["name"] for a in approvers.get(number, []) if a["status"] == "Pending"],
                        "last_action": last_actions.get(number),
                        "workflow_read": number in last_actions,
                        "lines": [
                            {
                                "line": l.get("RequisitionLineNumber"),
                                "status": l.get("LineStatus") or None,
                                "product": l.get("ProductName") or l.get("LineDescription") or None,
                                "description": l.get("LineDescription") or None,
                                "item_number": l.get("ItemNumber") or None,
                                "category": l.get("ProcurementProductCategoryName") or None,
                                "quantity": l.get("RequestedPurchaseQuantity"),
                                "unit": l.get("PurchaseUnitSymbol") or None,
                                "price": l.get("PurchasePrice"),
                                "amount": l.get("LineAmount"),
                                "currency": l.get("CurrencyCode") or None,
                                "vendor_account": l.get("VendorAccountNumber") or None,
                                "vendor_name": vendors.get(l.get("VendorAccountNumber") or "") or None,
                                "project_id": l.get("ProjectId") or None,
                                "requested_date": _date(l.get("RequestedDate")),
                            }
                            for l in req_lines
                        ],
                    }
                )
            return result, account
        finally:
            context.close()


def main() -> int:
    request = json.loads(sys.stdin.read() or "{}")
    list_url = (request.get("list_url") or "").strip() or DEFAULT_LIST_URL
    try:
        requisitions, account = fetch_requisitions(list_url)
    except LoginRequired:
        print(json.dumps({"requisitions": [], "account": None, "error": "login"}))
        return 2
    except Exception as exc:
        message = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
        print(json.dumps({"requisitions": [], "account": None, "error": message}))
        return 1
    print(json.dumps({"requisitions": requisitions, "account": account, "error": None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
