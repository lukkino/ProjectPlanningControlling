import os

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.project_folders import existing_folder, file_in_folder, free_filename, require_folder

router = APIRouter(tags=["review-folder"])

LABEL = "documenti delle review"


def _get_project_or_404(db: Session, project_id: int) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return project


@router.get("/api/projects/{project_id}/review-folder", response_model=schemas.FolderStatus)
def review_folder_status(project_id: int, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    folder = project.review_documents_folder
    return schemas.FolderStatus(folder=folder, folder_exists=existing_folder(folder) is not None)


@router.post("/api/projects/{project_id}/review-folder/files", response_model=schemas.SavedFile, status_code=201)
def save_review_file(
    project_id: int,
    filename: str = Query(...),
    overwrite: bool = Query(False),
    content: bytes = Body(..., media_type="application/octet-stream"),
    db: Session = Depends(get_db),
):
    """Scrive un documento generato nella cartella review dell'increment. Se
    il file c'e' gia' e overwrite e' falso risponde 409 col primo nome
    libero, da proporre all'utente insieme a "Sovrascrivi"."""
    folder = require_folder(_get_project_or_404(db, project_id).review_documents_folder, LABEL)
    path = file_in_folder(folder, filename)
    if path.exists() and not overwrite:
        raise HTTPException(
            status_code=409,
            detail={"message": f"Esiste gia' {filename}", "suggested": free_filename(folder, filename)},
        )
    try:
        path.write_bytes(content)
    except PermissionError as exc:
        # Tipicamente il file e' aperto in Excel/PowerPoint.
        raise HTTPException(status_code=423, detail=f"{filename} non si puo' scrivere: e' aperto in un altro programma?") from exc
    return schemas.SavedFile(filename=path.name)


@router.post("/api/projects/{project_id}/review-folder/open", status_code=204)
def open_review_folder(project_id: int, filename: str | None = Query(None), db: Session = Depends(get_db)):
    """Apre la cartella review in Esplora risorse, o un suo file con
    l'applicazione predefinita, sulla macchina del backend (quella
    dell'utente)."""
    folder = require_folder(_get_project_or_404(db, project_id).review_documents_folder, LABEL)
    path = file_in_folder(folder, filename) if filename else folder
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"File non trovato: {filename}")
    os.startfile(path)
