"""Legge i ticket del portale Product Certification (Freshservice), senza
finestra (headless), col profilo del browser dell'automazione del CO: il
login si fa da solo col pulsante "Sign in with SSO - Inpeco Employee" e
l'accesso Microsoft salvato nel profilo. Legge l'elenco "Tutti i ticket" e
poi la pagina di ogni ticket (campi della richiesta e del ticket).

    python -m app.services.tools.certification_tickets

Stampa righe "PROGRESS <fatti> <totale>" mentre legge i ticket e, sull'ultima
riga, un JSON {"tickets": [...], "error": ...} letto da
routers/tools_certifications.py. Codici di uscita: 0 letto, 2 login da
rifare, 1 altro errore. Non scrive nel database.
"""

import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

from app.services.tools.change_order_browser import PROFILE_DIR

PORTAL_URL = "https://inpeco-prodcertification.freshservice.com"
LIST_URL = f"{PORTAL_URL}/support/tickets"
SSO_BUTTON = "Sign in with SSO - Inpeco Employee"
LOGIN_TIMEOUT_S = 60
MAX_PAGES = 20

MONTHS = {
    "gen": 1, "feb": 2, "mar": 3, "apr": 4, "mag": 5, "giu": 6,
    "lug": 7, "ago": 8, "set": 9, "ott": 10, "nov": 11, "dic": 12,
}
# "Creato mar, 6 ott 2026 10:19" -> 2026-10-06T10:19
_CREATED_RE = re.compile(r"(\d{1,2})\s+([a-z]{3})\w*\s+(\d{4})\s+(\d{1,2}):(\d{2})", re.IGNORECASE)

# Riga dell'elenco: id, oggetto, stato, data di creazione, assegnatario.
LIST_JS = """() => [...document.querySelectorAll("a[href*='/support/tickets/']")]
  .filter(a => /\\/support\\/tickets\\/\\d+$/.test(a.getAttribute('href')))
  .map(a => {
    const text = s => { const e = a.querySelector(s); return e ? e.innerText.trim() : null }
    const h3 = a.querySelector('h3')
    const id = a.querySelector('.display-id')
    return {
      id: Number(a.getAttribute('href').split('/').pop()),
      display_id: id ? id.innerText.trim() : null,
      subject: h3 ? h3.innerText.replace(id ? id.innerText : '', '').trim() : null,
      status: text('.status'),
      created: text('.created-on'),
      assigned_to: (text('.assign-to') || '').replace(/^[^:]*:\\s*/, '') || null,
    }
  })"""

# Pagina del ticket: Fase, campi della richiesta e campi del ticket
# (etichetta -> valore), numero di risposte.
DETAIL_JS = """() => {
  const clean = s => (s || '').replace(/\\s*:\\s*$/, '').replace(/\\s+/g, ' ').trim()
  const item = {}
  for (const li of document.querySelectorAll('.requested-item-fields li.field')) {
    const label = clean(li.querySelector('.item-field-label')?.innerText)
    const value = (li.querySelector('.item-field-value')?.innerText || '').trim()
    if (label) item[label] = value || null
  }
  const ticket = {}
  for (const fs of document.querySelectorAll('#ticket-fields-container fieldset.ticket-field')) {
    const label = clean(fs.querySelector('.control-label label')?.innerText)
    if (!label) continue
    const selected = fs.querySelector('li.power-select-option.selected')
    const input = fs.querySelector('input[type=text]:not(.search-select), textarea')
    const value = selected ? selected.innerText.trim() : (input ? input.value.trim() : '')
    ticket[label] = value || null
  }
  const stage = document.querySelector('.additional-info label[for^=stage-] + p')
  return {
    stage: stage ? stage.innerText.trim() : null,
    item,
    ticket,
    replies: document.querySelectorAll('.note-detail-card').length,
  }
}"""


class LoginRequired(Exception):
    pass


def _progress(done: int, total: int) -> None:
    print(f"PROGRESS {done} {total}", flush=True)


def _created_iso(text: str | None) -> str | None:
    match = _CREATED_RE.search(text or "")
    if not match:
        return None
    day, month, year, hour, minute = match.groups()
    number = MONTHS.get(month.lower()[:3])
    if not number:
        return None
    return f"{int(year):04d}-{number:02d}-{int(day):02d}T{int(hour):02d}:{minute}"


def _open_list(page, url: str) -> None:
    """Apre l'elenco; se compare il login, clicca il pulsante SSO."""
    page.goto(url)
    start = time.monotonic()
    clicked = False
    while time.monotonic() - start < LOGIN_TIMEOUT_S:
        if "freshservice.com/support/tickets" in page.url:
            page.wait_for_load_state("domcontentloaded")
            return
        sso = page.get_by_text(SSO_BUTTON)
        try:
            if not clicked and sso.count() and sso.first.is_visible():
                sso.first.click()
                clicked = True
        except Exception:
            pass
        page.wait_for_timeout(500)
    raise LoginRequired(page.url)


def fetch_tickets() -> list[dict]:
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel=os.environ.get("CO_BROWSER_CHANNEL", "chrome"), headless=True
        )
        try:
            page = context.new_page()
            _open_list(page, LIST_URL)
            page.wait_for_timeout(1500)
            tickets: dict[int, dict] = {}
            for number in range(1, MAX_PAGES + 1):
                if number > 1:
                    _open_list(page, f"{LIST_URL}?page={number}")
                    page.wait_for_timeout(1000)
                rows = [r for r in page.evaluate(LIST_JS) if r["id"] not in tickets]
                if not rows:
                    break
                for row in rows:
                    row["created_at"] = _created_iso(row.pop("created"))
                    tickets[row["id"]] = row
            total = len(tickets)
            _progress(0, total)
            for done, ticket in enumerate(tickets.values(), start=1):
                page.goto(f"{PORTAL_URL}/support/tickets/{ticket['id']}")
                try:
                    page.wait_for_selector(".requested-item-fields, #ticket-fields-container", timeout=15000)
                except Exception:
                    pass
                ticket.update(page.evaluate(DETAIL_JS))
                _progress(done, total)
            return list(tickets.values())
        finally:
            context.close()


def main() -> int:
    try:
        tickets = fetch_tickets()
    except LoginRequired:
        print(json.dumps({"tickets": [], "error": "login"}))
        return 2
    except Exception as exc:
        message = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
        print(json.dumps({"tickets": [], "error": message}))
        return 1
    print(json.dumps({"tickets": tickets, "error": None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
