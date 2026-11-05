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
KICK_OFF_PHASE_NAME = "Kick-off"
CODE_FREEZE_PHASE_NAME = "Code freeze"
RELEASE_TO_MARKET_PHASE_NAME = "Release to Market"
# Fasi che portano le date dell'increment, riconosciute dal nome: non si
# rinominano e non si eliminano. La data aggiornata (planned_date) di
# ciascuna e' copiata sul campo dell'increment, che resta in sola lettura
# (vedi sync_phase_dates). Il Project start e' invece la prima fase, qualunque
# sia il suo nome: si rinomina, ma non si elimina.
DATE_PHASES = {
    CODE_FREEZE_PHASE_NAME: "code_freeze_date",
    RELEASE_TO_MARKET_PHASE_NAME: "planned_finish_date",
}


def _normalize(name: str) -> str:
    return name.strip().lower().replace("-", " ")


def _date_phase_name(phase: models.Phase) -> str | None:
    """Il nome standard se la fase porta una data dell'increment."""
    return next((name for name in DATE_PHASES if _normalize(name) == _normalize(phase.name)), None)


def _find_phase(project: models.Project, name: str) -> models.Phase | None:
    return next((p for p in project.phases if _normalize(p.name) == _normalize(name)), None)


def _first_phase(project: models.Project) -> models.Phase | None:
    return min(project.phases, key=lambda p: (p.order, p.id or 0), default=None)


def sync_phase_dates(project: models.Project) -> None:
    """Le date dell'increment sono quelle aggiornate delle fasi: Project
    start = la prima fase, Code freeze = Code freeze, Planned finish =
    Release to Market. I campi dell'increment ne sono solo la copia."""
    first = _first_phase(project)
    project.start_date = first.planned_date if first else None
    for name, field in DATE_PHASES.items():
        phase = _find_phase(project, name)
        setattr(project, field, phase.planned_date if phase else None)


def _ensure_phase(project: models.Project, name: str, order: int, fallback) -> None:
    """Aggiunge la fase se manca (spostando in giu' le successive) e, se
    non ha una data, le da' quella che l'increment aveva."""
    phase = _find_phase(project, name)
    if phase is None:
        for other in project.phases:
            if other.order >= order:
                other.order += 1
        phase = models.Phase(name=name, order=order)
        project.phases.append(phase)
    if phase.planned_date is None and fallback is not None:
        phase.planned_date = fallback
        if phase.original_date is None:
            phase.original_date = fallback


def ensure_date_phases(db: Session) -> None:
    """All'avvio: ogni increment ha una prima fase (Kick-off se non ne ha
    nessuna), Code freeze (dopo Planning, se c'e') e Release to Market (in
    fondo), con la data che l'increment aveva se la fase non ne ha una; poi
    le date dell'increment si riallineano alle fasi."""
    for project in db.query(models.Project).all():
        first = _first_phase(project)
        if first is None:
            _ensure_phase(project, KICK_OFF_PHASE_NAME, 1, project.start_date)
        elif first.planned_date is None and project.start_date is not None:
            first.planned_date = project.start_date
            if first.original_date is None:
                first.original_date = project.start_date
        planning = _find_phase(project, "Planning")
        order = planning.order + 1 if planning else max((p.order for p in project.phases), default=0) + 1
        _ensure_phase(project, CODE_FREEZE_PHASE_NAME, order, project.code_freeze_date)
        last = max((p.order for p in project.phases), default=0)
        _ensure_phase(project, RELEASE_TO_MARKET_PHASE_NAME, last + 1, project.planned_finish_date)
        # Posizioni 1, 2, 3... senza buchi ne' doppioni.
        for position, phase in enumerate(sorted(project.phases, key=lambda p: (p.order, p.id or 0)), start=1):
            phase.order = position
        sync_phase_dates(project)
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


@router.put("/{project_id}/pinned", status_code=204)
def set_project_pinned(project_id: int, payload: schemas.SidebarPin, db: Session = Depends(get_db)):
    """Fissa/sgancia l'increment nella sidebar. Non e' una modifica
    dell'increment: updated_at resta com'era."""
    if db.get(models.Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Increment non trovato")
    db.execute(
        update(models.Project)
        .where(models.Project.id == project_id)
        .values(sidebar_pinned=payload.pinned, updated_at=models.Project.updated_at)
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
    sync_phase_dates(phase.project)
    db.commit()
    db.refresh(phase)
    return phase


@router.put("/phases/{phase_id}", response_model=schemas.Phase)
def update_phase(phase_id: int, payload: schemas.PhaseUpdate, db: Session = Depends(get_db)):
    phase = db.get(models.Phase, phase_id)
    if phase is None:
        raise HTTPException(status_code=404, detail="Fase non trovata")
    data = payload.model_dump(exclude_unset=True)
    # Le fasi che portano le date dell'increment non si rinominano.
    standard = _date_phase_name(phase)
    if "name" in data and standard and data["name"] != phase.name:
        raise HTTPException(status_code=400, detail=f"La fase {standard} porta una data dell'increment: non si può rinominare")
    planned_changed = "planned_date" in data
    new_planned = data.pop("planned_date", None)
    for field, value in data.items():
        setattr(phase, field, value)
    if planned_changed:
        _set_phase_planned_date(phase, new_planned)
    sync_phase_dates(phase.project)
    db.commit()
    db.refresh(phase)
    return phase


@router.delete("/phases/{phase_id}", status_code=204)
def delete_phase(phase_id: int, db: Session = Depends(get_db)):
    phase = db.get(models.Phase, phase_id)
    if phase is None:
        raise HTTPException(status_code=404, detail="Fase non trovata")
    standard = _date_phase_name(phase)
    if standard:
        raise HTTPException(status_code=400, detail=f"La fase {standard} porta una data dell'increment: non si può eliminare")
    if phase is _first_phase(phase.project):
        raise HTTPException(status_code=400, detail="La prima fase porta il Project start dell'increment: non si può eliminare")
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
