"""Compila un target della parte Software di un Change Order (vedi
services/change_order_targets.py per come si ricavano i dati):

1. apre il CO e, se il target (PN) non c'e' ancora tra i Department Targets,
   lo crea da "New Targets" del dettaglio della riga Software, con Change
   Reason = PN;
2. apre il dettaglio del target;
3. per ogni riga Data Collection che manca: "+ New", Bom Level, Old Code,
   New Code e Code Description. Gli altri campi restano ai default del
   portale.

Lo script compila ma non salva: ogni Save lo preme l'utente (un banner in
cima alla pagina dice cosa controllare), poi lo script passa al passo
successivo. Righe e target gia' presenti si saltano, quindi si puo'
rilanciare.

    python -m app.services.tools.change_order_fill <project_id> <pn>
"""

import argparse
import json
import re

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

from app import models
from app.database import SessionLocal
from app.services.change_order_targets import ChangeOrderTarget, build_targets
from app.services.tools.change_order_browser import (
    find_software_target_row,
    launch,
    log,
    open_target_row,
    save_software_involved,
    setup_logging,
    wait_for_co_panel,
    write_status,
)

# Attesa del Save dell'utente: nessun limite (0 = infinito per Playwright).
NO_TIMEOUT = 0
# Attesa dei form del portale, che caricano dati in modo asincrono.
FORM_TIMEOUT_MS = 60000

BANNER_JS = """(text) => {
  let el = document.getElementById('ppc-co-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ppc-co-banner';
    el.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#1d4ed8;color:#fff;padding:10px 18px;font:600 15px Segoe UI,sans-serif;' +
      'border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:80vw;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = text;
}"""


class FillError(Exception):
    pass


def banner(page, text: str, waiting: bool = False) -> None:
    """Messaggio per l'utente: nel banner in cima alla pagina del portale e
    nel pannello di avanzamento dell'app (waiting = aspetta un suo Save)."""
    log.info("Banner: %s", text)
    write_status(text, message=text, waiting_user=waiting)
    try:
        page.evaluate(BANNER_JS, "Automazione CO — " + text)
    except PlaywrightError:
        pass  # pagina in navigazione: il banner e' solo un aiuto


def visible_in_frames(page, selector: str):
    for frame in page.frames:
        try:
            locator = frame.locator(selector)
            for i in range(locator.count()):
                if locator.nth(i).is_visible():
                    return locator.nth(i)
        except PlaywrightError:
            continue
    return None


def wait_visible(page, selector: str, timeout_ms: int = FORM_TIMEOUT_MS):
    elapsed = 0
    while timeout_ms == 0 or elapsed < timeout_ms:
        element = visible_in_frames(page, selector)
        if element is not None:
            return element
        page.wait_for_timeout(500)
        elapsed += 500
    raise FillError(f"Elemento {selector} non comparso")


def wait_hidden(page, selector: str) -> None:
    """Aspetta che un form si chiuda (Save o Close/Cancel dell'utente)."""
    while visible_in_frames(page, selector) is not None:
        page.wait_for_timeout(500)


def click_button(page, text: str, last: bool = False, css: str = "button, [role=button], [role=menuitem]") -> None:
    """Clicca un pulsante visibile e abilitato col testo dato (il primo, o
    l'ultimo nell'ordine della pagina)."""
    pattern = re.compile(r"^\W*" + re.escape(text) + r"\W*$")
    candidates = []
    for frame in page.frames:
        try:
            locator = frame.locator(css).filter(has_text=pattern)
            for i in range(locator.count()):
                item = locator.nth(i)
                if item.is_visible() and "is-disabled" not in (item.get_attribute("class") or ""):
                    candidates.append(item)
        except PlaywrightError:
            continue
    if not candidates:
        raise FillError(f"Pulsante {text!r} non trovato")
    (candidates[-1] if last else candidates[0]).click(timeout=10000)


def detail_open(page) -> bool:
    return visible_in_frames(page, "button:has-text('BOM Compare')") is not None


def close_detail(page) -> None:
    """Chiude il dettaglio di una riga (Close/Cancel in fondo al dettaglio,
    non quello della barra in alto che chiude tutto il CO)."""
    click_button(page, "Close/Cancel", last=True, css="button.ms-Button--default")
    page.wait_for_timeout(2000)


# Valore del menu "Select Change Description" di New Targets: per ora sempre
# questo (indicazione dell'utente).
CHANGE_DESCRIPTION = "Software"


def select_change_description(page, value: str) -> None:
    """Sceglie un valore nel menu a tendina "Select Change Description" (un
    react-select: si scrive per filtrare e si clicca l'opzione col testo
    esatto, cosi' "Software" non diventa "Software (PTB)")."""
    xpath = "xpath=//label[normalize-space()='Select Change Description']/following::input[@role='combobox'][1]"
    combo = visible_in_frames(page, xpath)
    if combo is None:
        raise FillError("Menu Select Change Description non trovato")
    combo.click()
    combo.press_sequentially(value, delay=30)
    page.wait_for_timeout(1500)
    option = visible_in_frames(page, f"[id*='-option-']:text-is('{value}')")
    if option is not None:
        option.click()
    else:
        log.warning("Opzione %r non trovata nel menu: provo con Invio", value)
        combo.press("Enter")
    page.wait_for_timeout(1500)


def create_target(page, label: str, pn: str) -> None:
    write_status(f"Il target {pn} non esiste: lo creo da New Targets", phase="Creazione target")
    if not open_target_row(page, label):
        raise FillError("Non riesco ad aprire la riga Software di Department Targets")
    wait_visible(page, "button:has-text('New Targets')")
    click_button(page, "New Targets")
    reason = wait_visible(page, "textarea#ChangeReason")
    page.wait_for_timeout(2000)  # il form precompila i campi dopo l'apertura
    # Prima il menu (potrebbe riempire da solo altri campi), poi Change
    # Reason, poi la verifica di entrambi i testi.
    select_change_description(page, CHANGE_DESCRIPTION)
    wrong = fill_form(page, [("textarea#Title", CHANGE_DESCRIPTION), ("textarea#ChangeReason", pn)])
    if wrong:
        raise FillError("Change Description / Change Reason non compilabili")
    banner(page, f"Nuovo target {pn}: controlla (Department Team compreso) e premi Save", waiting=True)
    wait_hidden(page, "textarea#ChangeReason")
    write_status(f"Form New Targets chiuso", waiting_user=False)
    page.wait_for_timeout(3000)


def refresh_targets_grid(page) -> bool:
    """Preme il pulsante di aggiornamento (refresh) della griglia Department
    Targets: dopo il Save di New Targets la riga nuova non compare da sola."""
    for frame in page.frames:
        try:
            grids = frame.locator(".dx-datagrid").filter(has_text="Department Team").filter(has_text="Change Reason")
            if grids.count() == 0:
                continue
            button = grids.last.locator("[role=button][aria-label='refresh']")
            if button.count() and button.first.is_visible():
                button.first.click()
                log.info("Aggiornata la griglia Department Targets")
                return True
        except PlaywrightError:
            continue
    log.warning("Pulsante di aggiornamento di Department Targets non trovato")
    return False


def wait_target_row(page, label: str, pn: str, seconds: int = 30) -> bool:
    """Aspetta che la riga del target compaia, aggiornando la griglia ogni 8
    secondi."""
    for second in range(seconds):
        if find_software_target_row(page, label, pn) is not None:
            return True
        if second % 8 == 0:
            refresh_targets_grid(page)
        page.wait_for_timeout(1000)
    return find_software_target_row(page, label, pn) is not None


def search_targets_grid(page, text: str) -> bool:
    """Scrive nella casella Search... della griglia Department Targets. La
    griglia (DevExtreme) mette nella pagina solo le righe nell'area visibile:
    una riga in fondo (es. il target appena creato) non si trova finche' non
    la si filtra o la si scorre."""
    for frame in page.frames:
        try:
            # L'ultima griglia con quelle colonne e' la piu' interna (la
            # lista dei CO la contiene).
            grids = frame.locator(".dx-datagrid").filter(has_text="Department Team").filter(has_text="Change Reason")
            if grids.count() == 0:
                continue
            search = grids.last.locator(".dx-datagrid-search-panel input")
            if search.count() == 0 or not search.first.is_visible():
                continue
            search.first.fill(text)
            page.wait_for_timeout(2500)  # filtro asincrono
            log.info("Department Targets filtrata per %r", text)
            return True
        except PlaywrightError:
            continue
    log.warning("Casella Search... di Department Targets non trovata")
    return False


def open_target(page, label: str, pn: str) -> None:
    """Apre il dettaglio del target; se la riga non si trova (tabella non
    aggiornata) chiede all'utente di aprirla."""
    write_status(f"Apro il target {pn}", phase="Apertura target")
    # Dopo New Targets il dettaglio della riga Software resta aperto sopra la
    # tabella: va chiuso prima di aprire il target. Niente filtro Search...
    # della griglia: le righe ci sono tutte, e il filtro le ricrea facendo
    # andare a vuoto il doppio clic.
    if detail_open(page):
        close_detail(page)
    if not wait_target_row(page, label, pn):
        log.warning("Riga %s non comparsa in Department Targets nemmeno aggiornando", pn)
    if open_target_row(page, label, pn):
        write_status(f"Target {pn} aperto")
        return
    banner(
        page,
        f"Non riesco ad aprire il target {pn} in Department Targets: aprilo tu col doppio clic, poi lo script continua",
        waiting=True,
    )
    wait_visible(page, "button:has-text('BOM Compare')", timeout_ms=NO_TIMEOUT)
    page.wait_for_timeout(2000)


def row_exists(page, new_code: str, description: str | None) -> bool:
    for frame in page.frames:
        try:
            # Cella intera (vedi find_software_target_row): PSDA_7.0.0 non
            # deve confondersi con PSDA_7.0.01.
            rows = frame.get_by_role("row").filter(has=frame.locator("td").get_by_text(new_code, exact=True))
            if description:
                rows = rows.filter(has_text=description)
            if rows.count() > 0:
                return True
        except PlaywrightError:
            continue
    return False


def wait_form_ready(page) -> None:
    """Il form Data Collection si apre vuoto e poco dopo carica i suoi
    default (es. Specific Impact = "No Impact") ridisegnando i campi: quello
    che si scrive prima va perso. Si aspetta che i default ci siano."""
    for _ in range(20):
        field = visible_in_frames(page, "input#SpecificImpactServiceManual")
        if field is not None and field.input_value().strip():
            break
        page.wait_for_timeout(500)
    page.wait_for_timeout(1500)


def type_into(page, selector: str, value: str) -> None:
    """Imposta il valore in un colpo solo (fill: svuota e scrive, con
    l'evento input che aggiorna lo stato React del form). Niente digitazione
    tasto per tasto: entrando in un campo il form si ridisegna e i primi
    tasti vanno persi, e nel textarea "seleziona tutto" non sostituisce il
    testo, quindi un nuovo tentativo lo raddoppiava."""
    field = visible_in_frames(page, selector)
    if field is None:
        raise FillError(f"Campo {selector} non trovato")
    field.fill("")
    field.fill(value)
    # Uscita dal campo come farebbe l'utente: alcuni form salvano sul blur.
    field.dispatch_event("blur")
    page.wait_for_timeout(400)  # lascia ridisegnare il form prima del campo dopo


def fill_form(page, values: list[tuple[str, str]]) -> list[str]:
    """Compila e ricontrolla i campi, riscrivendo quelli che il form ha
    svuotato o cambiato. Ritorna i selettori ancora sbagliati dopo 3 giri."""
    wrong: list[str] = []
    for attempt in range(3):
        for selector, value in values:
            field = visible_in_frames(page, selector)
            if field is None or field.input_value() != value:
                type_into(page, selector, value)
        page.wait_for_timeout(1500)
        wrong = []
        for selector, value in values:
            field = visible_in_frames(page, selector)
            if field is None or field.input_value() != value:
                wrong.append(selector)
        if not wrong:
            return []
        log.warning("Giro %s: campi da riscrivere %s", attempt + 1, wrong)
    return wrong


def wait_row_saved(page, new_code: str, description: str | None) -> bool:
    """Dopo il Save la griglia si aggiorna con qualche secondo di ritardo."""
    for _ in range(20):
        if row_exists(page, new_code, description):
            return True
        page.wait_for_timeout(500)
    return False


FIELD_NAMES = {
    "input#BomLevel": "Bom Level",
    "input#OldCode": "Old Code",
    "input#NewCode": "New Code",
    "textarea#CodeDescription": "Code Description",
}


def fill_rows(page, target: ChangeOrderTarget) -> list[str]:
    done: list[str] = []
    total = len(target.rows)
    present = 0
    write_status(phase="Righe Data Collection", rows_total=total, rows_done=0)
    for index, row in enumerate(target.rows, start=1):
        what = f"riga {index}/{total} ({row.new_code})"
        if row_exists(page, row.new_code, row.code_description):
            log.info("%s: gia' presente, salto", what)
            present += 1
            write_status(f"{what}: già presente, salto", rows_done=present + len(done))
            continue
        write_status(f"Compilo {what}")
        click_button(page, "New", last=True, css="[role=menuitem]")
        wait_visible(page, "input#BomLevel")
        wait_form_ready(page)
        wrong = fill_form(
            page,
            [
                ("input#BomLevel", str(row.bom_level)),
                ("input#OldCode", row.old_code or ""),
                ("input#NewCode", row.new_code),
                ("textarea#CodeDescription", row.code_description or ""),
            ],
        )
        notes = []
        if wrong:
            notes.append("non riesco a compilare " + ", ".join(FIELD_NAMES[s] for s in wrong) + ": compilali tu")
        if not row.old_code:
            notes.append("Old Code non trovato, compilalo tu")
        extra = (" — " + "; ".join(notes)) if notes else ""
        banner(page, f"Target {target.pn}, {what}: controlla e premi Save{extra}", waiting=True)
        wait_hidden(page, "input#BomLevel")
        write_status(waiting_user=False)
        if wait_row_saved(page, row.new_code, row.code_description):
            done.append(row.new_code)
            write_status(f"{what}: salvata", rows_done=present + len(done))
        else:
            log.warning("%s: non risulta salvata (Close/Cancel?)", what)
            write_status(f"{what}: non risulta salvata (Close/Cancel?)")
    return done


def load_target(project_id: int, pn: str) -> tuple[models.Project, ChangeOrderTarget]:
    with SessionLocal() as db:
        project = db.get(models.Project, project_id)
        if project is None or not project.change_order_url:
            raise FillError("Increment senza URL del Change Order")
        db.expunge(project)
        for target in build_targets(db, project):
            if target.pn == pn:
                return project, target
    raise FillError(f"{pn} non e' tra i PN dell'increment")


def run(project_id: int, pn: str) -> None:
    project, target = load_target(project_id, pn)
    label = project.change_order_label
    log.info("Compilo il target %s: %s", pn, json.dumps([r.__dict__ for r in target.rows]))
    with sync_playwright() as p:
        context = launch(p)
        page = context.pages[0] if context.pages else context.new_page()
        try:
            write_status("Apro il Change Order (se chiede il login, fallo nella finestra di Chrome)", phase="Apertura CO")
            kind, _ = wait_for_co_panel(page, project.change_order_url, label)
            if kind in ("popup", "targets"):
                save_software_involved(project_id, kind == "targets")
            if kind != "targets":
                raise FillError("Impatto Software non ancora impostato a Involved: fallo prima dal popup")
            # Due controlli a distanza: appena caricato il pannello la griglia
            # si ridisegna, e un target non visto verrebbe creato doppio.
            page.wait_for_timeout(2500)
            exists = find_software_target_row(page, label, pn) is not None
            if not exists:
                page.wait_for_timeout(2500)
                exists = find_software_target_row(page, label, pn) is not None
            if not exists:
                create_target(page, label, pn)
            else:
                write_status(f"Il target {pn} esiste già: non lo ricreo")
            open_target(page, label, pn)
            done = fill_rows(page, target)
            write_status(phase="Fatto")
            banner(page, f"Target {pn} finito ({len(done)} righe salvate ora). Controlla e chiudi la finestra")
        except FillError as exc:
            log.error("%s", exc)
            write_status(phase="Errore", error=str(exc))
            banner(page, f"Interrotto: {exc}. Puoi continuare a mano e chiudere la finestra")
        except PlaywrightError as exc:
            log.exception("Errore del browser")
            write_status(phase="Errore", error=str(exc).splitlines()[0])
            banner(page, "Interrotto per un errore (vedi change_order_browser.log). Chiudi la finestra")
        context.wait_for_event("close", timeout=0)
        log.info("Finestra chiusa")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_id", type=int)
    parser.add_argument("pn")
    args = parser.parse_args()
    setup_logging()
    try:
        run(args.project_id, args.pn)
    except Exception:
        log.exception("Errore")
        raise


if __name__ == "__main__":
    main()
