import os
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.scenarios import create_scenario_presentation, find_scenario_files

router = APIRouter(tags=["scenarios"])

URL_PATTERN = re.compile(r"^https?://", re.IGNORECASE)


def _clean_path(value: str) -> Path:
    # "Copia come percorso" di Esplora risorse lo mette tra virgolette.
    return Path(value.strip().strip('"'))


def _scenarios_folder(project: models.Project) -> Path | None:
    if not project.scenarios_folder:
        return None
    folder = _clean_path(project.scenarios_folder)
    return folder if folder.is_dir() else None


def _require_folder(project: models.Project) -> Path:
    folder = _scenarios_folder(project)
    if folder is None:
        detail = (
            f"La cartella Scenarios non esiste: {project.scenarios_folder}"
            if project.scenarios_folder
            else "Cartella Scenarios non impostata: impostala da Modifica increment"
        )
        raise HTTPException(status_code=400, detail=detail)
    return folder


def _get_story_or_400(db: Session, item_id: int) -> models.BacklogItem:
    item = db.get(models.BacklogItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Backlog item non trovato")
    if item.issue_type != "Story":
        raise HTTPException(status_code=400, detail="Gli scenari si creano solo per le Story")
    return item


@router.get("/api/projects/{project_id}/scenarios", response_model=schemas.ScenariosStatus)
def scenarios_status(project_id: int, db: Session = Depends(get_db)):
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    folder = _scenarios_folder(project)
    if folder is None:
        return schemas.ScenariosStatus(folder=project.scenarios_folder, folder_exists=False, files={})
    keys = [i.jira_key for i in project.backlog_items if i.issue_type == "Story"]
    return schemas.ScenariosStatus(
        folder=project.scenarios_folder, folder_exists=True, files=find_scenario_files(folder, keys)
    )


@router.post("/api/backlog/{item_id}/scenarios", response_model=schemas.ScenarioFile, status_code=201)
def create_scenarios(item_id: int, db: Session = Depends(get_db)):
    item = _get_story_or_400(db, item_id)
    folder = _require_folder(item.project)
    existing = find_scenario_files(folder, [item.jira_key]).get(item.jira_key)
    if existing:
        raise HTTPException(status_code=409, detail=f"Scenari gia' presenti: {existing}")
    return schemas.ScenarioFile(filename=create_scenario_presentation(folder, item, item.project))


@router.post("/api/backlog/{item_id}/scenarios/open", status_code=204)
def open_scenarios(item_id: int, db: Session = Depends(get_db)):
    """Apre il pptx con l'applicazione predefinita (PowerPoint) sulla
    macchina del backend, che per questa app e' quella dell'utente: un link
    file:// dalla pagina verrebbe bloccato dal browser. Vale il file
    collegato a mano, se c'e', altrimenti quello nella cartella Scenarios.
    Gli URL li apre direttamente il frontend."""
    item = _get_story_or_400(db, item_id)
    if item.scenarios_link and not URL_PATTERN.match(item.scenarios_link):
        path = _clean_path(item.scenarios_link)
        if not path.is_file():
            raise HTTPException(status_code=404, detail=f"File non trovato: {path}")
        os.startfile(path)
        return
    folder = _require_folder(item.project)
    filename = find_scenario_files(folder, [item.jira_key]).get(item.jira_key)
    if filename is None:
        raise HTTPException(status_code=404, detail="Presentazione degli scenari non trovata")
    os.startfile(folder / filename)


@router.post("/api/projects/{project_id}/scenarios/browse", response_model=schemas.ScenarioBrowseResult)
def browse_scenarios(project_id: int, db: Session = Depends(get_db)):
    """Finestra "Apri file" di Windows sulla macchina del backend (quella
    dell'utente), per scegliere una presentazione gia' fatta da collegare:
    il browser non da' il percorso completo dei file scelti. Parte dalla
    cartella Scenarios dell'increment, se impostata."""
    import tkinter
    from tkinter import filedialog

    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    folder = _scenarios_folder(project)
    root = tkinter.Tk()
    try:
        root.withdraw()
        # Davanti al browser, altrimenti la finestra si apre dietro.
        root.attributes("-topmost", True)
        path = filedialog.askopenfilename(
            parent=root,
            title="Presentazione degli scenari",
            initialdir=str(folder) if folder else None,
            filetypes=[("PowerPoint", "*.pptx"), ("Tutti i file", "*.*")],
        )
    finally:
        root.destroy()
    return schemas.ScenarioBrowseResult(path=str(Path(path)) if path else None)
