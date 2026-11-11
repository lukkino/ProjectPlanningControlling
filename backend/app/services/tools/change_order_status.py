"""Legge lo Status del Change Order dal portale SharePoint, senza finestra
(headless), col profilo del browser dell'automazione del CO: il login
Microsoft fatto li' vale anche qui. Salva lo Status sull'increment.

    python -m app.services.tools.change_order_status --project-id 2

Stampa sull'ultima riga un JSON {"status": ..., "error": ...} letto da
routers/change_order.py. Codici di uscita: 0 letto, 2 login da rifare,
1 altro errore.
"""

import argparse
import json
import os
import sys
import time

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

from app.services.tools.change_order_browser import (
    PANEL_WAIT_S,
    PROFILE_DIR,
    log,
    open_from_list,
    read_co_status,
    save_co_status,
    setup_logging,
)

# Tempo massimo per leggere lo Status (caricamento del portale e pannello).
STATUS_TIMEOUT_S = 90
# Se dopo questo tempo non si e' sul portale, il login salvato e' scaduto.
LOGIN_WAIT_S = 30


class LoginRequired(Exception):
    pass


def fetch_status(url: str, label: str | None) -> str | None:
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel=os.environ.get("CO_BROWSER_CHANNEL", "chrome"), headless=True
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            log.info("Leggo lo Status di %s", url)
            page.goto(url)
            start = time.monotonic()
            on_portal_since = None
            fallback_done = False
            while time.monotonic() - start < STATUS_TIMEOUT_S:
                status = read_co_status(page)
                if status:
                    return status
                if "sharepoint.com" in page.url:
                    on_portal_since = on_portal_since or time.monotonic()
                    if label and not fallback_done and time.monotonic() - on_portal_since > PANEL_WAIT_S:
                        fallback_done = True
                        try:
                            open_from_list(page, label)
                        except PlaywrightError:
                            log.exception("Apertura dalla lista non riuscita")
                elif time.monotonic() - start > LOGIN_WAIT_S:
                    raise LoginRequired(page.url)
                page.wait_for_timeout(1000)
            return None
        finally:
            context.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-id", type=int, required=True)
    args = parser.parse_args()
    setup_logging()

    from app import models
    from app.database import SessionLocal

    with SessionLocal() as db:
        project = db.get(models.Project, args.project_id)
        url = project.change_order_url if project else None
        label = project.change_order_label if project else None
    if not url:
        print(json.dumps({"status": None, "error": "Nessun link al Change Order"}))
        return 1
    try:
        status = fetch_status(url, label)
    except LoginRequired:
        log.warning("Login richiesto: Status non letto")
        print(json.dumps({"status": None, "error": "login"}))
        return 2
    except Exception as exc:
        log.exception("Lettura dello Status non riuscita")
        print(json.dumps({"status": None, "error": str(exc).splitlines()[0] if str(exc) else type(exc).__name__}))
        return 1
    if not status:
        print(json.dumps({"status": None, "error": "Status non trovato nel pannello del CO"}))
        return 1
    save_co_status(args.project_id, status)
    print(json.dumps({"status": status, "error": None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
