from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import update
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db

router = APIRouter(prefix="/api/projects", tags=["projects"])

# Fasi standard che ogni progetto deve avere almeno (create automaticamente
# alla creazione del progetto, senza date): la Dashboard progetti (Gantt) si
# affida a questo elenco fisso per colorare/etichettare le fasi in modo
# uniforme tra progetti diversi.
STANDARD_PHASE_NAMES = ["Kick-off", "Planning", "Execution", "Deployment", "Release to Market"]


def _get_project_or_404(db: Session, project_id: int) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return project


@router.get("", response_model=list[schemas.ProjectListItem])
def list_projects(db: Session = Depends(get_db)):
    return db.query(models.Project).order_by(models.Project.updated_at.desc()).all()


@router.put("/gantt-order", status_code=204)
def set_gantt_order(payload: schemas.ProjectGanttOrder, db: Session = Depends(get_db)):
    """Ordine manuale delle righe nel Gantt della Dashboard generale.
    Dichiarato prima di PUT /{project_id}, che altrimenti catturerebbe
    "gantt-order" come id. updated_at viene riscritto uguale a se stesso:
    riordinare il Gantt non e' una modifica dell'increment e non deve
    cambiare l'ordine "modificati di recente" della lista progetti."""
    for position, project_id in enumerate(payload.project_ids):
        db.execute(
            update(models.Project)
            .where(models.Project.id == project_id)
            .values(gantt_order=position, updated_at=models.Project.updated_at)
        )
    db.commit()


@router.post("", response_model=schemas.ProjectDetail, status_code=201)
def create_project(payload: schemas.ProjectCreate, db: Session = Depends(get_db)):
    project = models.Project(**payload.model_dump())
    db.add(project)
    db.flush()  # assegna project.id, serve per le fasi sotto
    for order, name in enumerate(STANDARD_PHASE_NAMES, start=1):
        db.add(models.Phase(project_id=project.id, name=name, order=order))
    db.commit()
    db.refresh(project)
    return project


@router.get("/{project_id}", response_model=schemas.ProjectDetail)
def get_project(project_id: int, db: Session = Depends(get_db)):
    return _get_project_or_404(db, project_id)


@router.put("/{project_id}", response_model=schemas.ProjectDetail)
def update_project(project_id: int, payload: schemas.ProjectUpdate, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(project, field, value)
    db.commit()
    db.refresh(project)
    return project


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    # Scollega i progetti invece di lasciarli orfani/cancellarli: sono
    # un'entita' a se' (budget/rendicontazione), valida anche senza un
    # Project (rilascio) a cui essere collegata.
    for progetto in project.progetti:
        progetto.project_id = None
    db.delete(project)
    db.commit()


# ---------- Phases ----------

@router.get("/{project_id}/phases", response_model=list[schemas.Phase])
def list_phases(project_id: int, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    return db.query(models.Phase).filter(models.Phase.project_id == project_id).order_by(models.Phase.order).all()


@router.post("/{project_id}/phases", response_model=schemas.Phase, status_code=201)
def create_phase(project_id: int, payload: schemas.PhaseCreate, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    phase = models.Phase(project_id=project_id, **payload.model_dump())
    db.add(phase)
    db.commit()
    db.refresh(phase)
    return phase


@router.put("/phases/{phase_id}", response_model=schemas.Phase)
def update_phase(phase_id: int, payload: schemas.PhaseUpdate, db: Session = Depends(get_db)):
    phase = db.get(models.Phase, phase_id)
    if phase is None:
        raise HTTPException(status_code=404, detail="Fase non trovata")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(phase, field, value)
    db.commit()
    db.refresh(phase)
    return phase


@router.delete("/phases/{phase_id}", status_code=204)
def delete_phase(phase_id: int, db: Session = Depends(get_db)):
    phase = db.get(models.Phase, phase_id)
    if phase is None:
        raise HTTPException(status_code=404, detail="Fase non trovata")
    db.delete(phase)
    db.commit()
