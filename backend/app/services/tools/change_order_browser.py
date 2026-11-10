"""Apre un Change Order sul portale SharePoint e porta l'utente alla parte
Software dell'Execution:

- CO nuovo: clicca il pulsante "CO2026-0223-03 - Software (PTB)" nel
  pannello, che apre il popup Involved / Not Involved;
- impatto gia' scelto: il pulsante non c'e' piu' e si apre col doppio clic
  la riga del team Software nella tabella "Department Targets" (dettaglio
  con New Targets e la griglia Data Collection dei PN).

Nessuno dei due ha un link diretto: l'URL resta quello del CO.

Gira come processo separato (vedi routers/change_order.py) perche' la
finestra deve restare aperta dopo la risposta HTTP:

    python -m app.services.tools.change_order_browser <url_co> [--label CO2026-0223]

Usa un profilo Chrome dedicato in backend/data/browser-profile: il login
Microsoft si fa la prima volta in quella finestra e poi resta salvato. Il
canale del browser si cambia con CO_BROWSER_CHANNEL (chrome, msedge).
"""

import argparse
import datetime as dt
import json
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
# Department Team della riga Software nella tabella Department Targets.
SOFTWARE_TEAM = "Software (PTB)"

log = logging.getLogger("change_order_browser")

# Avanzamento dell'automazione, letto dall'app (GET /api/change-order/status)
# per mostrare all'utente cosa sta succedendo nella finestra del browser.
STATUS_FILE = DATA_DIR / "change_order_status.json"
STATUS_EVENTS = 30


def read_status() -> dict:
    try:
        return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_status(event: str | None = None, reset: bool = False, **fields) -> None:
    """Aggiorna il file di stato: i campi passati sostituiscono i precedenti,
    event si aggiunge allo storico (con l'ora). reset riparte da zero."""
    status = {} if reset else read_status()
    status.update(fields)
    status["updated_at"] = dt.datetime.now().isoformat(timespec="seconds")
    if event:
        events = status.get("events", [])
        events.append({"at": dt.datetime.now().strftime("%H:%M:%S"), "text": event})
        status["events"] = events[-STATUS_EVENTS:]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATUS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATUS_FILE)  # l'app non legge mai un file a meta'


def co_prefix(label: str | None) -> str:
    return re.escape(label.strip()) if label and label.strip() else r"CO\d{4}-\d{4}"


def software_button_pattern(label: str | None) -> re.Pattern:
    """Testo del pulsante, es. "CO2026-0223-03 - Software (PTB)"."""
    return re.compile(co_prefix(label) + r"-\d+\s*-\s*Software", re.IGNORECASE)


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


def find_software_target_row(page, label: str | None, change_reason: str | None = None):
    """Riga del team Software nella tabella "Department Targets" del pannello
    (es. "CO2026-0223-03 | Software | Software (PTB) | Software | PTB-CLN.025"):
    c'e' dopo che l'impatto Software e' stato impostato a Involved, e col
    doppio clic apre il dettaglio con la griglia Data Collection dei PN. Con
    change_reason, solo la riga di quel target (PN)."""
    row_number = re.compile(co_prefix(label) + r"-\d+")
    for frame in page.frames:
        try:
            rows = frame.get_by_role("row").filter(has_text=row_number).filter(has_text=SOFTWARE_TEAM)
            if change_reason:
                # Confronto con una cella intera: nel testo della riga le
                # celle sono attaccate ("PTB-SRV.021" + "04-In Progress"),
                # quindi una regex sul testo della riga non basta.
                rows = rows.filter(has=frame.locator("td").get_by_text(change_reason, exact=True))
            if rows.count() > 0:
                return rows.first
        except PlaywrightError:
            continue
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


def launch(p):
    """Contesto del browser col profilo dedicato (login salvato)."""
    channel = os.environ.get("CO_BROWSER_CHANNEL", "chrome")
    # chromium_sandbox: senza, Playwright aggiunge --no-sandbox e Chrome
    # mostra l'avviso "unsupported command-line flag".
    return p.chromium.launch_persistent_context(
        str(PROFILE_DIR),
        channel=channel,
        headless=False,
        no_viewport=True,
        chromium_sandbox=True,
        args=["--start-maximized"],
    )


def open_row(row) -> None:
    """Doppio clic su una riga di Department Targets (senza verifica: vedi
    open_target_row)."""
    log.info("Doppio clic sulla riga Department Targets: %r", row.inner_text().strip()[:200])
    row.scroll_into_view_if_needed()
    row.locator("td").first.dblclick()


def detail_visible(page) -> bool:
    """Il dettaglio di una riga di Department Targets e' aperto."""
    for frame in page.frames:
        try:
            button = frame.locator("button:has-text('BOM Compare')")
            if button.count() and button.first.is_visible():
                return True
        except PlaywrightError:
            continue
    return False


def open_target_row(page, label: str | None, change_reason: str | None = None, attempts: int = 3) -> bool:
    """Apre il dettaglio della riga Software (di un target, con
    change_reason) e verifica che si sia aperto. Appena caricato il pannello
    la griglia si ridisegna e un doppio clic puo' finire sulla riga vecchia:
    si aspetta un attimo, e se il dettaglio non compare si ritrova la riga e
    si riprova."""
    page.wait_for_timeout(2500)
    for attempt in range(1, attempts + 1):
        row = find_software_target_row(page, label, change_reason)
        if row is None:
            log.warning("Tentativo %s: riga %s non trovata", attempt, change_reason or "Software")
        else:
            try:
                open_row(row)
            except PlaywrightError:
                log.warning("Tentativo %s: doppio clic non riuscito", attempt)
            for _ in range(24):  # fino a 12 secondi
                if detail_visible(page):
                    page.wait_for_timeout(1500)
                    return True
                page.wait_for_timeout(500)
            log.warning("Tentativo %s: dettaglio non aperto", attempt)
        page.wait_for_timeout(2000)
    return False


def open_software_section(page, url: str, label: str | None) -> str | None:
    """Porta alla parte Software del CO. Ritorna "popup" (Involved / Not
    Involved), "detail" (dettaglio della riga Software) o None se non ci
    riesce entro BUTTON_TIMEOUT_S."""
    kind, element = wait_for_co_panel(page, url, label)
    if kind == "popup":
        log.info("Clic su %r", element.inner_text().strip())
        element.scroll_into_view_if_needed()
        element.click()
        return "popup"
    if kind == "targets":
        return "detail" if open_target_row(page, label) else None
    return None


def wait_for_co_panel(page, url: str, label: str | None):
    """Apre il CO e aspetta il pannello. Ritorna ("popup", pulsante Software)
    se l'impatto Software non e' ancora stato scelto, ("targets", riga
    Software di Department Targets) se si', (None, None) se non ci riesce
    entro BUTTON_TIMEOUT_S."""
    pattern = software_button_pattern(label)
    log.info("Apro %s", url)
    page.goto(url)

    deadline = time.monotonic() + BUTTON_TIMEOUT_S
    on_portal_since = None
    fallback_done = False
    while time.monotonic() < deadline:
        # CO nuovo: pulsante Software -> popup Involved / Not Involved.
        button = find_visible(page, pattern)
        if button is not None:
            return "popup", button
        # Impatto gia' scelto: riga Software in Department Targets.
        target_row = find_software_target_row(page, label)
        if target_row is not None:
            return "targets", target_row
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
    log.warning("Ne' pulsante Software ne' riga Department Targets trovati entro %ss", BUTTON_TIMEOUT_S)
    return None, None


def run(url: str, label: str | None) -> None:
    with sync_playwright() as p:
        context = launch(p)
        page = context.pages[0] if context.pages else context.new_page()
        write_status("Apro il Change Order (se chiede il login, fallo nella finestra di Chrome)", phase="Apertura CO")
        reached = open_software_section(page, url, label)
        if reached == "popup":
            write_status("Popup Software aperto: scegli Involved / Not Involved nella finestra", phase="Fatto")
        elif reached == "detail":
            write_status("Dettaglio della riga Software aperto", phase="Fatto")
        else:
            write_status("Parte Software del CO non trovata", phase="Errore", error="Parte Software non trovata")
        # La finestra resta all'utente: il processo finisce quando la chiude.
        context.wait_for_event("close", timeout=0)
        log.info("Finestra chiusa")


def setup_logging() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_FILE, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--label")
    args = parser.parse_args()
    setup_logging()
    try:
        run(args.url, args.label)
    except Exception:
        log.exception("Errore")
        raise


if __name__ == "__main__":
    main()
