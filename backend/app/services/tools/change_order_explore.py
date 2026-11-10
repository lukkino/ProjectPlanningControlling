"""Strumento di sviluppo: arriva alla parte Software di un CO (come
change_order_browser), clicca eventualmente uno o piu' pulsanti e salva in
backend/data/co_debug/ screenshot ed elenco dei controlli visibili (input,
select, pulsanti, etichette...) di ogni frame. Non salva nulla sul portale:
alla fine chiude la finestra.

    python -m app.services.tools.change_order_explore <url_co> --label CO2026-0223 --click "New Targets"
"""

import argparse
import json
import re

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

from app.services.tools.change_order_browser import DATA_DIR, launch, log, open_software_section, setup_logging

DEBUG_DIR = DATA_DIR / "co_debug"

DUMP_JS = """() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const sel = 'input, textarea, select, button, a, label, [role=combobox], [role=button], [role=listbox], ' +
              '[role=option], [role=dialog], [role=tab], [contenteditable=true]';
  return Array.from(document.querySelectorAll(sel)).filter(visible).map((el) => ({
    tag: el.tagName, role: el.getAttribute('role'), type: el.getAttribute('type'), id: el.id || null,
    name: el.getAttribute('name'), aria: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder'),
    cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 100),
    text: (el.innerText || '').trim().slice(0, 100), value: el.value === undefined ? null : String(el.value).slice(0, 100),
  }));
}"""


def dump(page, name: str) -> None:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(DEBUG_DIR / f"{name}.png"))
    frames = []
    for frame in page.frames:
        try:
            frames.append({"url": frame.url, "controls": frame.evaluate(DUMP_JS)})
        except PlaywrightError as exc:
            frames.append({"url": frame.url, "error": str(exc)})
    (DEBUG_DIR / f"{name}.json").write_text(json.dumps(frames, indent=1, ensure_ascii=False), encoding="utf-8")
    log.info("Dump %s salvato in %s", name, DEBUG_DIR)


def click_text(page, text: str) -> bool:
    """Clicca il primo pulsante visibile con quel testo; con il prefisso
    "last:" l'ultimo (es. "last:New" = il New della griglia Data Collection,
    dopo quello della lista dei CO)."""
    last = text.startswith("last:")
    text = text.removeprefix("last:")
    # Il nome accessibile puo' continuare (es. "New. Use left and right arrow keys...").
    pattern = re.compile(r"^\W*" + re.escape(text) + r"\b")
    candidates = []
    for frame in page.frames:
        try:
            # Ordine del documento (button e menuitem insieme), senza i
            # pulsanti disabilitati (Fluent UI li marca con is-disabled).
            locator = frame.locator("button, [role=button], [role=menuitem]").filter(has_text=pattern)
            for i in range(locator.count()):
                item = locator.nth(i)
                if item.is_visible() and "is-disabled" not in (item.get_attribute("class") or ""):
                    candidates.append(item)
        except PlaywrightError:
            continue
    log.info("Candidati per %r: %s", text, [c.inner_text().strip().replace("\n", " ")[:30] for c in candidates])
    if not candidates:
        return False
    (candidates[-1] if last else candidates[0]).click(timeout=10000)
    return True


def diagnose_targets_grid(page, label: str | None, pn: str) -> None:
    """Perche' la riga del target non si trova: griglie candidate, righe
    presenti nella pagina prima e dopo il filtro Search..., e scorrimento."""
    from app.services.tools.change_order_browser import find_software_target_row
    from app.services.tools.change_order_fill import search_targets_grid

    for f_index, frame in enumerate(page.frames):
        grids = frame.locator(".dx-datagrid")
        for g in range(grids.count()):
            grid = grids.nth(g)
            text = grid.inner_text()
            if "Department Team" in text:
                rows = grid.get_by_role("row")
                log.info(
                    "Frame %s griglia %s: %s righe, search=%s, contiene %s: %s",
                    f_index, g, rows.count(), grid.locator(".dx-datagrid-search-panel input").count(),
                    pn, pn in text,
                )
    log.info("Prima del filtro, riga trovata: %s", find_software_target_row(page, label, pn) is not None)
    dump(page, "10_before-search")
    search_targets_grid(page, pn)
    page.wait_for_timeout(3000)
    log.info("Dopo il filtro, riga trovata: %s", find_software_target_row(page, label, pn) is not None)
    for frame in page.frames:
        rows = frame.get_by_role("row").filter(has_text=pn)
        for i in range(rows.count()):
            log.info("Riga con %s: %r", pn, rows.nth(i).inner_text()[:300])
    dump(page, "11_after-search")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--label")
    parser.add_argument("--diagnose-target", help="PN del target da cercare in Department Targets")
    parser.add_argument("--click", action="append", default=[], help="testo del pulsante da cliccare (ripetibile)")
    parser.add_argument("--wait", type=int, default=4000, help="attesa in ms dopo ogni passo")
    args = parser.parse_args()
    setup_logging()
    with sync_playwright() as p:
        context = launch(p)
        page = context.pages[0] if context.pages else context.new_page()
        try:
            if args.diagnose_target:
                from app.services.tools.change_order_browser import wait_for_co_panel

                wait_for_co_panel(page, args.url, args.label)
                page.wait_for_timeout(args.wait)
                diagnose_targets_grid(page, args.label, args.diagnose_target)
                return
            reached = open_software_section(page, args.url, args.label)
            page.wait_for_timeout(args.wait)
            dump(page, f"00_{reached or 'none'}")
            for i, text in enumerate(args.click, start=1):
                ok = click_text(page, text)
                log.info("Clic su %r: %s", text, "ok" if ok else "NON TROVATO")
                page.wait_for_timeout(args.wait)
                dump(page, f"{i:02d}_{re.sub(r'[^A-Za-z0-9]+', '-', text)}")
        finally:
            context.close()


if __name__ == "__main__":
    main()
