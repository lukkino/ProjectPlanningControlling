from fastapi import APIRouter, Depends, HTTPException
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
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    db.commit()
    db.refresh(project)
    return project


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
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


# ---------- Budget lines ----------

@router.get("/{project_id}/budget-lines", response_model=list[schemas.BudgetLine])
def list_budget_lines(project_id: int, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    return (
        db.query(models.BudgetLine)
        .filter(models.BudgetLine.project_id == project_id)
        .order_by(models.BudgetLine.order)
        .all()
    )


@router.post("/{project_id}/budget-lines", response_model=schemas.BudgetLine, status_code=201)
def create_budget_line(project_id: int, payload: schemas.BudgetLineCreate, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    line = models.BudgetLine(project_id=project_id, **payload.model_dump())
    db.add(line)
    db.commit()
    db.refresh(line)
    return line


@router.put("/budget-lines/{line_id}", response_model=schemas.BudgetLine)
def update_budget_line(line_id: int, payload: schemas.BudgetLineUpdate, db: Session = Depends(get_db)):
    line = db.get(models.BudgetLine, line_id)
    if line is None:
        raise HTTPException(status_code=404, detail="Riga di budget non trovata")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(line, field, value)
    db.commit()
    db.refresh(line)
    return line


@router.delete("/budget-lines/{line_id}", status_code=204)
def delete_budget_line(line_id: int, db: Session = Depends(get_db)):
    line = db.get(models.BudgetLine, line_id)
    if line is None:
        raise HTTPException(status_code=404, detail="Riga di budget non trovata")
    db.delete(line)
    db.commit()
