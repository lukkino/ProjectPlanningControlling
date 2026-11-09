"""Apre un Change Order sul portale SharePoint e porta l'utente al popup delle
attivita' Software (pulsante "CO2026-0223-03 - Software (PTB)" nel pannello
del CO), che non ha un link diretto: l'URL resta quello del CO.

Gira come processo separato (vedi routers/change_order.py) perche' la
finestra deve restare aperta dopo la risposta HTTP:

    python -m app.services.tools.change_order_browser <url_co> [--label CO2026-0223]

Usa un profilo Chrome dedicato in backend/data/browser-profile: il login
Microsoft si fa la prima volta in quella finestra e poi resta salvato. Il
canale del browser si cambia con CO_BROWSER_CHANNEL (chrome, msedge).
"""

import argparse
import logging
import os
import re
import time
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
PROFILE_DIR = DATA_DIR / "browser-profile"
LOG_FILE = DATA_DIR / "change_order_browser.log"

# Tempo massimo per trovare il pulsante: comprende l'eventuale login.
BUTTON_TIMEOUT_S = 300
# Attesa del pannello del CO, una volta sul portale, prima di aprirlo dalla lista.
PANEL_WAIT_S = 15

log = logging.getLogger("change_order_browser")


def software_button_pattern(label: str | None) -> re.Pattern:
    """Testo del pulsante, es. "CO2026-0223-03 - Software (PTB)"."""
    prefix = re.escape(label.strip()) if label and label.strip() else r"CO\d{4}-\d{4}"
    return re.compile(prefix + r"-\d+\s*-\s*Software", re.IGNORECASE)


def find_visible(page, pattern: re.Pattern):
    """Cerca il testo in tutti i frame: il form del CO potrebbe stare in un iframe."""
    for frame in page.frames:
        try:
            locator = frame.get_by_text(pattern)
            for i in range(locator.count()):
                if locator.nth(i).is_visible():
                    return locator.nth(i)
        except PlaywrightError:
            continue  # frame staccato durante la navigazione
    return None


def open_from_list(page, label: str) -> None:
    """Ripiego quando il link del CO carica la lista senza aprire il pannello
    (succede ad esempio dopo il login): cerca il CO nella casella "Search..."
    della griglia e clicca l'icona della colonna "SF365 Action" della riga."""
    for frame in page.frames:
        search = frame.get_by_placeholder("Search...", exact=True)
        try:
            if search.count() == 0 or not search.first.is_visible():
                continue
        except PlaywrightError:
            continue
        log.info("Pannello non aperto: cerco %s nella lista", label)
        search.first.fill(label)
        page.wait_for_timeout(3000)  # la griglia filtra in modo asincrono
        rows = frame.get_by_role("row").filter(has_text=label)
        if rows.count() == 0:
            log.warning("Nessuna riga con %s nella lista", label)
            return
        cell = rows.first.locator("td").first
        log.info("Riga trovata, prima cella: %s", cell.inner_html()[:1500])
        clickable = cell.locator("img, svg, i, button, a, [role='button']")
        (clickable.first if clickable.count() else cell).click()
        return
    log.warning("Casella Search... della lista non trovata")


def run(url: str, label: str | None) -> None:
    pattern = software_button_pattern(label)
    channel = os.environ.get("CO_BROWSER_CHANNEL", "chrome")
    with sync_playwright() as p:
        # chromium_sandbox: senza, Playwright aggiunge --no-sandbox e Chrome
        # mostra l'avviso "unsupported command-line flag".
        context = p.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            channel=channel,
            headless=False,
            no_viewport=True,
            chromium_sandbox=True,
            args=["--start-maximized"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        log.info("Apro %s", url)
        page.goto(url)

        deadline = time.monotonic() + BUTTON_TIMEOUT_S
        on_portal_since = None
        fallback_done = False
        button = None
        while time.monotonic() < deadline:
            button = find_visible(page, pattern)
            if button is not None:
                break
            # Il conteggio parte solo quando si e' sul portale (non durante
            # il login): se il pannello non compare, si apre dalla lista.
            if "sharepoint.com" in page.url:
                on_portal_since = on_portal_since or time.monotonic()
                if label and not fallback_done and time.monotonic() - on_portal_since > PANEL_WAIT_S:
                    fallback_done = True
                    try:
                        open_from_list(page, label)
                    except PlaywrightError:
                        log.exception("Apertura dalla lista non riuscita")
            else:
                on_portal_since = None
            page.wait_for_timeout(1000)

        if button is None:
            log.warning("Pulsante Software non trovato entro %ss (pattern %s)", BUTTON_TIMEOUT_S, pattern.pattern)
        else:
            log.info("Clic su %r", button.inner_text().strip())
            button.scroll_into_view_if_needed()
            button.click()

        # La finestra resta all'utente: il processo finisce quando la chiude.
        context.wait_for_event("close", timeout=0)
        log.info("Finestra chiusa")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--label")
    args = parser.parse_args()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_FILE, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", encoding="utf-8"
    )
    try:
        run(args.url, args.label)
    except Exception:
        log.exception("Errore")
        raise


if __name__ == "__main__":
    main()
