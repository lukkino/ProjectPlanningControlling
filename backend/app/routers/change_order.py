import json
import subprocess
import sys
import threading
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app import models
from app.database import get_db
from app.services.change_order_targets import build_targets
from app.services.tools.change_order_browser import read_status, write_status

router = APIRouter(tags=["change-order"])

BACKEND_DIR = Path(__file__).resolve().parents[2]

# Una sola finestra alla volta: il profilo del browser non si puo' aprire
# due volte insieme.
_browser_process: subprocess.Popen | None = None
# Lettura dello Status in corso (stesso profilo: una alla volta).
_status_lock = threading.Lock()
STATUS_READ_TIMEOUT_S = 150


def _project_with_co(db: Session, project_id: int) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    if not project.change_order_url:
        raise HTTPException(status_code=400, detail="Configura prima l'URL del Change Order.")
    return project


def _running() -> bool:
    return _browser_process is not None and _browser_process.poll() is None


def _start_browser(args: list[str], project_id: int, action: str, pn: str | None = None) -> None:
    global _browser_process
    if _running():
        raise HTTPException(
            status_code=409, detail="La finestra del Change Order è già aperta: chiudila prima di aprirne un'altra."
        )
    write_status(
        "Avvio del browser…",
        reset=True,
        project_id=project_id,
        action=action,
        pn=pn,
        phase="Avvio",
        message="Avvio del browser…",
        waiting_user=False,
    )
    _browser_process = subprocess.Popen([sys.executable, "-m", *args], cwd=BACKEND_DIR)


@router.get("/api/change-order/status")
def change_order_status():
    """Avanzamento dell'automazione del CO (scritto dallo script, vedi
    change_order_browser.write_status) e se la finestra e' ancora aperta."""
    return {**read_status(), "running": _running()}


@router.post("/api/projects/{project_id}/change-order/open-software", status_code=202)
def open_change_order_software(project_id: int, db: Session = Depends(get_db)):
    """Apre, sulla macchina del backend, una finestra del browser sul Change
    Order dell'increment, sulla parte Software (vedi
    services/tools/change_order_browser.py)."""
    project = _project_with_co(db, project_id)
    args = ["app.services.tools.change_order_browser", project.change_order_url, "--project-id", str(project_id)]
    if project.change_order_label:
        args += ["--label", project.change_order_label]
    _start_browser(args, project_id, "open-software")
    return {"status": "opening"}


@router.get("/api/projects/{project_id}/change-order/targets")
def change_order_targets(project_id: int, db: Session = Depends(get_db)):
    """I target Software del CO (un PN ciascuno) con le righe Data
    Collection, ricavati dalla tab Components & PN."""
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return [asdict(target) for target in build_targets(db, project)]


@router.post("/api/projects/{project_id}/change-order/fill-target", status_code=202)
def fill_change_order_target(project_id: int, pn: str = Query(...), db: Session = Depends(get_db)):
    """Apre il CO e compila il target del PN (vedi
    services/tools/change_order_fill.py): l'utente preme ogni Save."""
    project = _project_with_co(db, project_id)
    if pn not in {target.pn for target in build_targets(db, project)}:
        raise HTTPException(status_code=400, detail=f"{pn} non è tra i PN dell'increment")
    _start_browser(["app.services.tools.change_order_fill", str(project_id), pn], project_id, "fill-target", pn)
    return {"status": "opening"}


@router.post("/api/projects/{project_id}/change-order/refresh-status")
def refresh_change_order_status(project_id: int, db: Session = Depends(get_db)):
    """Legge lo Status del CO dal portale, senza finestra (vedi
    services/tools/change_order_status.py), e lo salva sull'increment."""
    _project_with_co(db, project_id)
    if _running():
        raise HTTPException(
            status_code=409, detail="La finestra del Change Order è aperta: chiudila per aggiornare lo stato."
        )
    if not _status_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Lettura dello stato del CO già in corso.")
    try:
        result = subprocess.run(
            [sys.executable, "-m", "app.services.tools.change_order_status", "--project-id", str(project_id)],
            cwd=BACKEND_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=STATUS_READ_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Il portale del CO non ha risposto in tempo.")
    finally:
        _status_lock.release()
    lines = [line for line in result.stdout.splitlines() if line.strip().startswith("{")]
    outcome = json.loads(lines[-1]) if lines else {"status": None, "error": "Nessuna risposta dalla lettura"}
    if outcome.get("error") == "login":
        raise HTTPException(
            status_code=409,
            detail='Login Microsoft scaduto: apri il CO una volta con "Imposta impatto Software" e rifai il login.',
        )
    if not outcome.get("status"):
        raise HTTPException(status_code=502, detail=f"Stato del CO non letto: {outcome.get('error')}")
    db.expire_all()
    project = db.get(models.Project, project_id)
    return {"co_status": project.co_status, "co_status_checked_at": project.co_status_checked_at}
