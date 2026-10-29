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
STANDARD_PHASE_NAMES = ["Kick-off", "Planning", "Code freeze", "Execution", "Deployment", "Release to Market"]
CODE_FREEZE_PHASE_NAME = "Code freeze"


def _is_code_freeze_phase(phase: models.Phase) -> bool:
    return phase.name.strip().lower().replace("-", " ") == "code freeze"


def sync_code_freeze(project: models.Project) -> None:
    """Il code freeze ufficiale e' la data aggiornata della fase "Code
    freeze": project.code_freeze_date ne e' solo la copia."""
    phase = next((p for p in project.phases if _is_code_freeze_phase(p)), None)
    project.code_freeze_date = phase.planned_date if phase else None


def ensure_code_freeze_phases(db: Session) -> None:
    """All'avvio: ogni increment ha la fase "Code freeze" (dopo Planning,
    se c'e'), con la data che l'increment aveva se la fase non ne ha una;
    poi la copia sull'increment si riallinea alla fase."""
    for project in db.query(models.Project).all():
        phase = next((p for p in project.phases if _is_code_freeze_phase(p)), None)
        if phase is None:
            planning = next((p for p in project.phases if p.name == "Planning"), None)
            order = planning.order + 1 if planning else len(project.phases) + 1
            for other in project.phases:
                if other.order >= order:
                    other.order += 1
            phase = models.Phase(name=CODE_FREEZE_PHASE_NAME, order=order)
            project.phases.append(phase)
        if phase.planned_date is None and project.code_freeze_date is not None:
            phase.planned_date = project.code_freeze_date
            if phase.original_date is None:
                phase.original_date = project.code_freeze_date
        sync_code_freeze(project)
    db.commit()


def _set_phase_planned_date(phase: models.Phase, new_date) -> None:
    """Cambia la data pianificata aggiornata registrando il cambio nello
    storico; la prima data pianificata diventa anche quella originale."""
    if new_date == phase.planned_date:
        return
    if phase.planned_date is not None:
        phase.changes.append(models.PhaseDateChange(old_date=phase.planned_date, new_date=new_date))
    if phase.original_date is None:
        phase.original_date = new_date
    phase.planned_date = new_date


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
    for sub_project in project.sub_projects:
        sub_project.project_id = None
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
    if phase.original_date is None:
        phase.original_date = phase.planned_date
    db.add(phase)
    db.flush()
    db.refresh(phase.project)
    sync_code_freeze(phase.project)
    db.commit()
    db.refresh(phase)
    return phase


@router.put("/phases/{phase_id}", response_model=schemas.Phase)
def update_phase(phase_id: int, payload: schemas.PhaseUpdate, db: Session = Depends(get_db)):
    phase = db.get(models.Phase, phase_id)
    if phase is None:
        raise HTTPException(status_code=404, detail="Fase non trovata")
    data = payload.model_dump(exclude_unset=True)
    # La fase "Code freeze" porta il code freeze ufficiale: non si rinomina.
    if "name" in data and _is_code_freeze_phase(phase) and data["name"] != phase.name:
        raise HTTPException(status_code=400, detail="La fase Code freeze non si può rinominare")
    planned_changed = "planned_date" in data
    new_planned = data.pop("planned_date", None)
    for field, value in data.items():
        setattr(phase, field, value)
    if planned_changed:
        _set_phase_planned_date(phase, new_planned)
    sync_code_freeze(phase.project)
    db.commit()
    db.refresh(phase)
    return phase


@router.delete("/phases/{phase_id}", status_code=204)
def delete_phase(phase_id: int, db: Session = Depends(get_db)):
    phase = db.get(models.Phase, phase_id)
    if phase is None:
        raise HTTPException(status_code=404, detail="Fase non trovata")
    if _is_code_freeze_phase(phase):
        raise HTTPException(status_code=400, detail="La fase Code freeze porta il code freeze ufficiale: non si può eliminare")
    db.delete(phase)
    db.commit()


# ---------- Giorni non lavorativi ----------

def _check_range(day: models.NonWorkingDay) -> None:
    if day.end_date < day.start_date:
        raise HTTPException(status_code=422, detail="La data di fine precede quella di inizio")


@router.get("/{project_id}/non-working-days", response_model=list[schemas.NonWorkingDay])
def list_non_working_days(project_id: int, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    return (
        db.query(models.NonWorkingDay)
        .filter(models.NonWorkingDay.project_id == project_id)
        .order_by(models.NonWorkingDay.start_date)
        .all()
    )


@router.post("/{project_id}/non-working-days", response_model=schemas.NonWorkingDay, status_code=201)
def create_non_working_day(project_id: int, payload: schemas.NonWorkingDayCreate, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    day = models.NonWorkingDay(project_id=project_id, **payload.model_dump())
    _check_range(day)
    db.add(day)
    db.commit()
    db.refresh(day)
    return day


@router.put("/non-working-days/{day_id}", response_model=schemas.NonWorkingDay)
def update_non_working_day(day_id: int, payload: schemas.NonWorkingDayUpdate, db: Session = Depends(get_db)):
    day = db.get(models.NonWorkingDay, day_id)
    if day is None:
        raise HTTPException(status_code=404, detail="Giorno non lavorativo non trovato")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(day, field, value)
    _check_range(day)
    db.commit()
    db.refresh(day)
    return day


@router.delete("/non-working-days/{day_id}", status_code=204)
def delete_non_working_day(day_id: int, db: Session = Depends(get_db)):
    day = db.get(models.NonWorkingDay, day_id)
    if day is None:
        raise HTTPException(status_code=404, detail="Giorno non lavorativo non trovato")
    db.delete(day)
    db.commit()
