"""Scritture e link delle RDA in Dynamics 365, col browser dell'automazione
(stesso profilo e login di purchase_requisitions.py).

    python -m app.services.tools.purchase_requisition_writer < richiesta.json

Richieste (JSON su stdin, "list_url" come per la lettura):
- {"action": "link", "number": "RDA154605"}: apre la RDA e chiede a
  Dynamics il suo link (Opzioni > Ottieni un collegamento). Il link e'
  cifrato da Dynamics: non si puo' costruire dal numero, ma resta valido.
- {"action": "add_lines", "number": ..., "lines": [...]}: aggiunge le righe a
  una RDA in bozza (entita' OData PurchaseRequisitionLinesV2). Dynamics
  completa da solo indirizzo di consegna, dimensioni finanziarie e gruppi
  IVA; la categoria di progetto si ricava dalle righe passate dell'utente con
  la stessa categoria di approvvigionamento.

Le scritture partono dalla pagina di Dynamics (fetch nella pagina): fatte
direttamente con la sessione del browser Dynamics risponde 401.

Stampa righe "PROGRESS <fatti> <totale>" e, sull'ultima riga, un JSON
{"url"|"results"+"lines", "error"}. Codici di uscita: 0 ok, 2 login da
rifare, 1 altro errore.
"""

import collections
import json
import os
import sys
import urllib.parse

from playwright.sync_api import sync_playwright

from app.services.tools.change_order_browser import PROFILE_DIR
from app.services.tools.purchase_requisitions import (
    DEFAULT_LIST_URL,
    NUMBER_INPUT,
    SHELL_IDLE_JS,
    LoginRequired,
    _first_requisition_number,
    _get,
    _progress,
    _query,
    _quote,
    _vendor_name,
    _vendors,
)

# Righe passate dell'utente da cui ricavare la categoria di progetto.
HISTORY_REQUISITIONS = 40


def _open_requisition(page, number: str) -> None:
    """Dalla pagina elenco apre il dettaglio della RDA: la si filtra, il
    primo clic sul numero seleziona la riga, il secondo apre la RDA."""
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
    cell = page.locator(f'{NUMBER_INPUT}[value="{number}"]').first
    for _ in range(3):
        page.wait_for_function(SHELL_IDLE_JS, timeout=20000)
        cell.click()
        try:
            page.wait_for_url("**mi=PurchReqTable**", timeout=6000)
            break
        except Exception:
            continue
    else:
        raise RuntimeError(f"RDA {number} non aperta in Dynamics")
    page.wait_for_function(SHELL_IDLE_JS, timeout=30000)
    page.wait_for_timeout(1000)


def _requisition_link(page, number: str) -> str:
    _open_requisition(page, number)
    page.locator("text=/^Opzioni$/ >> visible=true").last.click()
    page.wait_for_timeout(800)
    page.locator("text=Ottieni un collegamento >> visible=true").last.click()
    page.wait_for_function(
        "() => [...document.querySelectorAll('input')].some(i => /[?&]q=/.test(i.value) && /PurchReqTable/.test(i.value))",
        timeout=20000,
    )
    url = page.evaluate(
        "() => [...document.querySelectorAll('input')].map(i => i.value)"
        ".find(v => /[?&]q=/.test(v) && /PurchReqTable/.test(v))"
    )
    page.keyboard.press("Escape")
    if not url:
        raise RuntimeError("Dynamics non ha dato il link della RDA")
    return url


def _date(value: str | None, fallback: str | None) -> str | None:
    """"2026-05-18" -> data OData di Dynamics (mezzogiorno UTC, come le sue)."""
    if value:
        return f"{value}T12:00:00Z"
    return fallback


def _project_categories(context, base_url: str, preparer: str) -> dict[str, str]:
    """Categoria di approvvigionamento -> categoria di progetto piu' usata
    nelle ultime RDA dell'utente."""
    headers = _get(context, base_url, _query("PurchaseRequisitionHeaders", f"PreparerPersonnelNumber eq {_quote(preparer)}"))
    numbers = sorted(h["RequisitionNumber"] for h in headers)[-HISTORY_REQUISITIONS:]
    counts: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for i in range(0, len(numbers), 10):
        filter_ = " or ".join(f"RequisitionNumber eq {_quote(n)}" for n in numbers[i:i + 10])
        for line in _get(
            context,
            base_url,
            _query("PurchaseRequisitionLinesV2", filter_, ["ProcurementProductCategoryName", "ProjectCategoryId"]),
        ):
            if line.get("ProcurementProductCategoryName") and line.get("ProjectCategoryId"):
                counts[line["ProcurementProductCategoryName"].lower()][line["ProjectCategoryId"]] += 1
    return {category: c.most_common(1)[0][0] for category, c in counts.items()}


def _post_line(page, payload: dict) -> tuple[int, str]:
    return tuple(
        page.evaluate(
            """async (body) => {
                const r = await fetch('/data/PurchaseRequisitionLinesV2', {method: 'POST', credentials: 'include',
                  headers: {'Content-Type': 'application/json', 'Accept': 'application/json'}, body: JSON.stringify(body)})
                return [r.status, await r.text()]
            }""",
            payload,
        )
    )


def _error_message(body: str) -> str:
    """Messaggio leggibile da una risposta di errore OData di Dynamics."""
    try:
        error = json.loads(body).get("error", {})
        inner = error.get("innererror", {}) or {}
        message = inner.get("message") or error.get("message") or body
    except (ValueError, AttributeError):
        message = body
    # Dynamics accoda dettagli tecnici dopo una riga vuota.
    return " ".join(message.split())[:400]


def _line_out(line: dict, vendors: dict[tuple[str, str], str], entity: str | None) -> dict:
    """Riga nel formato salvato dal tool RDA (vedi purchase_requisitions.py)."""
    date = line.get("RequestedDate") or ""
    return {
        "line": line.get("RequisitionLineNumber"),
        "status": line.get("LineStatus") or None,
        "product": line.get("ProductName") or line.get("LineDescription") or None,
        "description": line.get("LineDescription") or None,
        "item_number": line.get("ItemNumber") or None,
        "category": line.get("ProcurementProductCategoryName") or None,
        "quantity": line.get("RequestedPurchaseQuantity"),
        "unit": line.get("PurchaseUnitSymbol") or None,
        "price": line.get("PurchasePrice"),
        "amount": line.get("LineAmount"),
        "currency": line.get("CurrencyCode") or None,
        "vendor_account": line.get("VendorAccountNumber") or None,
        "vendor_name": _vendor_name(vendors, line.get("BuyingLegalEntityId") or entity, line.get("VendorAccountNumber")),
        "project_id": line.get("ProjectId") or None,
        "requested_date": None if not date or date.startswith("1900-01-01") else date[:10],
    }


def add_lines(context, page, base_url: str, number: str, lines: list[dict]) -> dict:
    found = _get(context, base_url, _query("PurchaseRequisitionHeaders", f"RequisitionNumber eq {_quote(number)}"))
    if not found:
        raise RuntimeError(f"RDA {number} non trovata in Dynamics")
    header = found[0]
    if header.get("RequisitionStatus") != "Draft":
        raise RuntimeError(f"La RDA {number} non è in bozza: Dynamics non permette di aggiungere righe")
    existing = _get(context, base_url, _query("PurchaseRequisitionLinesV2", f"RequisitionNumber eq {_quote(number)}"))
    next_line = max([l["RequisitionLineNumber"] for l in existing] + [0]) + 1
    project_categories = _project_categories(context, base_url, header["PreparerPersonnelNumber"])

    # Il fornitore deve esistere nella societa' della RDA: lo stesso codice
    # in un'altra societa' e' un altro fornitore.
    entity = (header.get("ProjectBuyingLegalEntityId") or "isp").lower()
    known_vendors = {
        code for (area, code) in _vendors(context, base_url, (l["vendor"] for l in lines if l.get("vendor"))) if area == entity
    }

    results = []
    _progress(0, len(lines))
    for done, line in enumerate(lines, start=1):
        if line.get("vendor") and line["vendor"] not in known_vendors:
            results.append(
                {"row": line["row"], "ok": False, "error": f"fornitore {line['vendor']} non trovato nella società {entity.upper()}"}
            )
            _progress(done, len(lines))
            continue
        payload = {
            "RequisitionNumber": number,
            "RequisitionLineNumber": next_line,
            "BuyingLegalEntityId": header.get("ProjectBuyingLegalEntityId") or "isp",
            "LineType": "Category",
            "ProcurementProductCategoryName": line["category"],
            "ProductName": line["product"],
            "RequestedPurchaseQuantity": line["quantity"],
            "PurchaseUnitSymbol": line["unit"],
            "PurchasePrice": line["price"],
            "PurchasePriceQuantity": 1,
            "CurrencyCode": line.get("currency") or "EUR",
            # Progetto e motivo sono dell'intestazione: uguali per tutte le righe.
            "ProjectId": header.get("DefaultProjectId") or "",
            "RequestedDate": _date(line.get("requested_date"), header.get("DefaultRequestedDate")),
            "AccountingDate": header.get("DefaultAccountingDate"),
        }
        if line.get("vendor"):
            payload["VendorAccountNumber"] = line["vendor"]
        project_category = project_categories.get(line["category"].lower())
        if project_category:
            payload["ProjectCategoryId"] = project_category
        justification = header.get("DefaultBusinessJustificationCode")
        if justification:
            payload["BusinessJustificationCode"] = justification
        details = header.get("DefaultBusinessJustificationDetails")
        if details:
            payload["BusinessJustificationDetails"] = details
        status, body = _post_line(page, payload)
        if status in (401, 403):
            raise LoginRequired("scrittura non autorizzata")
        if status in (200, 201):
            results.append({"row": line["row"], "ok": True, "line": next_line})
            next_line += 1
        else:
            results.append({"row": line["row"], "ok": False, "error": _error_message(body)})
        _progress(done, len(lines))

    after = _get(context, base_url, _query("PurchaseRequisitionLinesV2", f"RequisitionNumber eq {_quote(number)}"))
    after.sort(key=lambda l: l.get("RequisitionLineNumber") or 0)
    try:
        vendors = _vendors(context, base_url, (l["VendorAccountNumber"] for l in after if l.get("VendorAccountNumber")))
    except RuntimeError:
        vendors = {}
    return {"results": results, "lines": [_line_out(l, vendors, entity) for l in after]}


def run(request: dict) -> dict:
    list_url = (request.get("list_url") or "").strip() or DEFAULT_LIST_URL
    parts = urllib.parse.urlsplit(list_url)
    base_url = f"{parts.scheme}://{parts.netloc}"
    number = request["number"]
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            channel=os.environ.get("CO_BROWSER_CHANNEL", "chrome"),
            headless=True,
            viewport={"width": 1500, "height": 900},
        )
        try:
            page = context.new_page()
            _progress(0, 0)
            # Login e pagina di Dynamics aperta: serve anche alle scritture.
            _first_requisition_number(page, list_url)
            if request["action"] == "link":
                return {"url": _requisition_link(page, number)}
            if request["action"] == "add_lines":
                return add_lines(context, page, base_url, number, request.get("lines") or [])
            raise RuntimeError(f"azione sconosciuta: {request['action']}")
        finally:
            context.close()


def main() -> int:
    request = json.loads(sys.stdin.read() or "{}")
    try:
        outcome = run(request)
    except LoginRequired:
        print(json.dumps({"error": "login"}))
        return 2
    except Exception as exc:
        message = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
        print(json.dumps({"error": message}))
        return 1
    print(json.dumps({**outcome, "error": None}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
