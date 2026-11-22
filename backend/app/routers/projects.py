import datetime as dt
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import update
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.ownership import scope_user_id

router = APIRouter(prefix="/api/projects", tags=["projects"])

# Fasi standard che ogni progetto deve avere almeno (create automaticamente
# alla creazione del progetto, senza date): la Dashboard progetti (Gantt) si
# affida a questo elenco fisso per colorare/etichettare le fasi in modo
# uniforme tra progetti diversi.
STANDARD_PHASE_NAMES = ["Kick-off", "Planning", "Code freeze", "Execution", "Deployment", "Release to Market"]
# Fasi iniziali di un nuovo increment, scelte alla creazione: Full Review
# (tutte le review) o Medium Change (code freeze e la review di Medium
# Change, che vale anche come rilascio). Poi le fasi si aggiungono e tolgono
# a mano.
MEDIUM_CHANGE_PHASE_NAME = "Medium Change"
PHASE_TEMPLATES = {
    "full_review": STANDARD_PHASE_NAMES,
    "medium_change": ["Code freeze", MEDIUM_CHANGE_PHASE_NAME],
}
KICK_OFF_PHASE_NAME = "Kick-off"
CODE_FREEZE_PHASE_NAME = "Code freeze"
RELEASE_TO_MARKET_PHASE_NAME = "Release to Market"
# Le fasi hanno nomi liberi: si creano, rinominano ed eliminano senza
# vincoli. Le date dell'increment (Project start, Code freeze, Planned
# finish) vengono dalle fasi scelte per ciascuna (start_phase_id...): la data
# aggiornata (planned_date) della fase e' copiata sul campo dell'increment,
# che resta in sola lettura (vedi sync_phase_dates). Fase non scelta o
# eliminata = data vuota.
DATE_PHASE_LINKS = {
    "start_phase_id": "start_date",
    "code_freeze_phase_id": "code_freeze_date",
    "finish_phase_id": "planned_finish_date",
}


def _normalize(name: str) -> str:
    return name.strip().lower().replace("-", " ")


def _find_phase(project: models.Project, name: str) -> models.Phase | None:
    return next((p for p in project.phases if _normalize(p.name) == _normalize(name)), None)


def sync_phase_dates(project: models.Project) -> None:
    """Le date dell'increment sono quelle aggiornate delle fasi scelte;
    i campi dell'increment ne sono solo la copia."""
    by_id = {p.id: p for p in project.phases}
    for link, field in DATE_PHASE_LINKS.items():
        phase = by_id.get(getattr(project, link))
        if phase is None:
            setattr(project, link, None)
        setattr(project, field, phase.planned_date if phase else None)


def _fill_planned_from_original(phase: models.Phase, previous_original=None) -> None:
    """La data Aggiornata segue l'Originale finche' non e' stata spostata per
    conto suo: vuota, o uguale all'Originale di prima (es. si corregge
    l'Originale appena inserita). E' quella che danno le date
    dell'increment, Gantt e dashboard. Senza storico: non e' uno
    spostamento."""
    if phase.original_date is None:
        return
    if phase.planned_date is None or (previous_original is not None and phase.planned_date == previous_original):
        phase.planned_date = phase.original_date


def sync_all_phase_dates(db: Session) -> None:
    """All'avvio: le fasi con la sola data Originale prendono anche
    l'Aggiornata, poi le date di ogni increment si riallineano alle fasi
    scelte."""
    for project in db.query(models.Project).all():
        for phase in project.phases:
            _fill_planned_from_original(phase)
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
    return (
        db.query(models.Project)
        .filter(models.Project.owner_id == scope_user_id())
        .order_by(models.Project.updated_at.desc())
        .all()
    )


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
            .where(models.Project.id == project_id, models.Project.owner_id == scope_user_id())
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
    data = payload.model_dump()
    template = data.pop("phase_template", "full_review")
    project = models.Project(**data, owner_id=scope_user_id())
    db.add(project)
    db.flush()  # assegna project.id, serve per le fasi sotto
    for order, name in enumerate(PHASE_TEMPLATES[template], start=1):
        db.add(models.Phase(project_id=project.id, name=name, order=order))
    db.flush()
    db.refresh(project)
    # Date dell'increment, cambiabili poi dall'utente: Full Review =
    # Kick-off, Code freeze e Release to Market; Medium Change = Code freeze
    # e, come fine, la review di Medium Change (e' il rilascio); l'inizio lo
    # sceglie l'utente.
    project.code_freeze_phase_id = _find_phase(project, CODE_FREEZE_PHASE_NAME).id
    if template == "medium_change":
        project.finish_phase_id = _find_phase(project, MEDIUM_CHANGE_PHASE_NAME).id
    else:
        project.start_phase_id = _find_phase(project, KICK_OFF_PHASE_NAME).id
        project.finish_phase_id = _find_phase(project, RELEASE_TO_MARKET_PHASE_NAME).id
    db.commit()
    db.refresh(project)
    return project


@router.get("/{project_id}", response_model=schemas.ProjectDetail)
def get_project(project_id: int, db: Session = Depends(get_db)):
    return _get_project_or_404(db, project_id)


@router.put("/{project_id}", response_model=schemas.ProjectDetail)
def update_project(
    project_id: int, payload: schemas.ProjectUpdate, request: Request, db: Session = Depends(get_db)
):
    project = _get_project_or_404(db, project_id)
    data = payload.model_dump(exclude_unset=True)
    note = (data.pop("scope_change_note", None) or "").strip() or None
    if "scope" in data and project.scope_frozen_at is not None and _scope_content(data["scope"]) != _scope_content(project.scope):
        db.add(
            models.ScopeRevision(
                project_id=project.id,
                kind="change",
                previous_html=project.scope,
                html=data["scope"],
                note=note,
                user_name=_user_name(request),
            )
        )
    phase_ids = {p.id for p in project.phases}
    for link in DATE_PHASE_LINKS:
        if data.get(link) is not None and data[link] not in phase_ids:
            raise HTTPException(status_code=400, detail="La fase scelta non è di questo increment")
    for field, value in data.items():
        setattr(project, field, value)
    sync_phase_dates(project)
    db.commit()
    db.refresh(project)
    return project


# ---------- Scope congelato ----------

_CHECKED_RE = re.compile(r'\s(?:data-checked="(?:true|false)"|checked="checked")')


def _scope_content(html: str | None) -> str:
    """Lo Scope senza lo stato delle caselle: spuntare una voce e' un
    avanzamento, non una modifica dello Scope congelato."""
    return _CHECKED_RE.sub("", html or "")


def _user_name(request: Request) -> str | None:
    user = getattr(request.state, "user", None)
    return (user.display_name or user.username) if user is not None else None


def _scope_history(project: models.Project) -> schemas.ScopeHistory:
    return schemas.ScopeHistory(
        frozen_at=project.scope_frozen_at,
        frozen_by=project.scope_frozen_by,
        baseline=project.scope_baseline,
        revisions=[schemas.ScopeRevision.model_validate(r) for r in reversed(project.scope_revisions)],
    )


@router.get("/{project_id}/scope/history", response_model=schemas.ScopeHistory)
def scope_history(project_id: int, db: Session = Depends(get_db)):
    return _scope_history(_get_project_or_404(db, project_id))


@router.post("/{project_id}/scope/freeze", response_model=schemas.ScopeHistory)
def freeze_scope(
    project_id: int,
    payload: schemas.ScopeFreeze,
    request: Request,
    db: Session = Depends(get_db),
):
    """Congela lo Scope schematico com'e' ora (baseline); se era gia'
    congelato, la baseline diventa lo Scope attuale. Da qui ogni modifica
    finisce nel registro."""
    project = _get_project_or_404(db, project_id)
    now = dt.datetime.utcnow()
    project.scope_frozen_at = now
    project.scope_frozen_by = _user_name(request)
    project.scope_baseline = project.scope
    db.add(
        models.ScopeRevision(
            project_id=project.id,
            kind="freeze",
            html=project.scope,
            note=(payload.note or "").strip() or None,
            user_name=project.scope_frozen_by,
            created_at=now,
        )
    )
    db.commit()
    db.refresh(project)
    return _scope_history(project)


@router.post("/{project_id}/scope/unfreeze", response_model=schemas.ScopeHistory)
def unfreeze_scope(project_id: int, request: Request, db: Session = Depends(get_db)):
    """Scongela lo Scope: le modifiche non si registrano piu'. Il registro
    resta (con lo scongelamento)."""
    project = _get_project_or_404(db, project_id)
    if project.scope_frozen_at is None:
        raise HTTPException(status_code=400, detail="Lo Scope non è congelato")
    project.scope_frozen_at = None
    project.scope_frozen_by = None
    project.scope_baseline = None
    db.add(models.ScopeRevision(project_id=project.id, kind="unfreeze", user_name=_user_name(request)))
    db.commit()
    db.refresh(project)
    return _scope_history(project)


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
    _fill_planned_from_original(phase)
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
    planned_changed = "planned_date" in data
    new_planned = data.pop("planned_date", None)
    previous_original = phase.original_date
    for field, value in data.items():
        setattr(phase, field, value)
    if planned_changed:
        _set_phase_planned_date(phase, new_planned)
    else:
        _fill_planned_from_original(phase, previous_original)
    # Le milestone collegate seguono la fase (vedi models.align_milestone).
    for item in db.query(models.BacklogItem).filter(models.BacklogItem.milestone_phase_id == phase.id):
        models.align_milestone(item, phase)
    sync_phase_dates(phase.project)
    db.commit()
    db.refresh(phase)
    return phase


@router.delete("/phases/{phase_id}", status_code=204)
def delete_phase(phase_id: int, db: Session = Depends(get_db)):
    phase = db.get(models.Phase, phase_id)
    if phase is None:
        raise HTTPException(status_code=404, detail="Fase non trovata")
    project = phase.project
    for item in db.query(models.BacklogItem).filter(models.BacklogItem.milestone_phase_id == phase.id):
        item.milestone_phase_id = None
    # Se dava una data all'increment, la data resta vuota (si sceglie
    # un'altra fase dalle impostazioni dell'increment).
    for link in DATE_PHASE_LINKS:
        if getattr(project, link) == phase.id:
            setattr(project, link, None)
    db.delete(phase)
    db.flush()
    db.refresh(project)
    sync_phase_dates(project)
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
