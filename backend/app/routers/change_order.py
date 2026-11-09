import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models
from app.database import get_db

router = APIRouter(tags=["change-order"])

BACKEND_DIR = Path(__file__).resolve().parents[2]

# Una sola finestra alla volta: il profilo del browser non si puo' aprire
# due volte insieme.
_browser_process: subprocess.Popen | None = None


@router.post("/api/projects/{project_id}/change-order/open-software", status_code=202)
def open_change_order_software(project_id: int, db: Session = Depends(get_db)):
    """Apre, sulla macchina del backend, una finestra del browser sul Change
    Order dell'increment e clicca il pulsante delle attivita' Software (vedi
    services/tools/change_order_browser.py)."""
    global _browser_process
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    if not project.change_order_url:
        raise HTTPException(status_code=400, detail="Configura prima l'URL del Change Order.")
    if _browser_process is not None and _browser_process.poll() is None:
        raise HTTPException(
            status_code=409, detail="La finestra del Change Order è già aperta: chiudila prima di aprirne un'altra."
        )
    command = [sys.executable, "-m", "app.services.tools.change_order_browser", project.change_order_url]
    if project.change_order_label:
        command += ["--label", project.change_order_label]
    _browser_process = subprocess.Popen(command, cwd=BACKEND_DIR)
    return {"status": "opening"}
