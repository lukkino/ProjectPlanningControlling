import datetime as dt
import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, object_session

from app import models, schemas
from app.database import get_db
from app.routers.settings import SETTINGS_ROW_ID
from app.services.db_backup import DatabaseBackupError, backup_database
from app.services.jira_client import JiraClientError, JiraIssue, search_issues, test_connection

router = APIRouter(tags=["backlog"])

# Avanzamento delle sync in corso, per progetto: la POST di sync resta
# bloccante, intanto il frontend interroga la GET .../sync/progress. In
# memoria basta: un solo processo backend, e a sync finita non serve piu'.
_sync_progress: dict[int, schemas.SyncProgress] = {}


def _get_project_or_404(db: Session, project_id: int) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return project


def _get_item_or_404(db: Session, item_id: int) -> models.BacklogItem:
    item = db.get(models.BacklogItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Backlog item non trovato")
    return item


@router.get("/api/projects/{project_id}/backlog", response_model=list[schemas.BacklogItem])
def list_backlog(project_id: int, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    return (
        db.query(models.BacklogItem)
        .filter(models.BacklogItem.project_id == project_id, models.BacklogItem.archived_at.is_(None))
        .order_by(models.BacklogItem.priority_order)
        .all()
    )


@router.get("/api/projects/{project_id}/backlog/archived", response_model=list[schemas.BacklogItem])
def list_archived_backlog(project_id: int, db: Session = Depends(get_db)):
    """Item che la sync non ha piu' trovato nella JQL, dal piu' recente."""
    _get_project_or_404(db, project_id)
    return (
        db.query(models.BacklogItem)
        .filter(models.BacklogItem.project_id == project_id, models.BacklogItem.archived_at.is_not(None))
        .order_by(models.BacklogItem.archived_at.desc(), models.BacklogItem.jira_key)
        .all()
    )


@router.post("/api/backlog/{item_id}/restore", response_model=schemas.BacklogItem)
def restore_backlog_item(item_id: int, db: Session = Depends(get_db)):
    """Riporta nel backlog un item archiviato, con tutti i suoi dati. Se non
    rientra nella JQL, la sync successiva lo archivia di nuovo."""
    item = _get_item_or_404(db, item_id)
    item.archived_at = None
    db.commit()
    db.refresh(item)
    return item


@router.post("/api/projects/{project_id}/backlog", response_model=schemas.BacklogItem, status_code=201)
def create_backlog_item(project_id: int, payload: schemas.BacklogItemCreate, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    data = payload.model_dump(exclude_unset=True)
    _normalize_activity(data)
    item = models.BacklogItem(project_id=project_id, **data)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _normalize_activity(data: dict) -> None:
    """Un'attivita' di servizio e' sempre fuori dal code freeze: segnarla
    (con la sua fase) toglie il codefreeze, rimettere il codefreeze la fa
    tornare un item normale. is_activity e activity_phase restano allineati:
    is_activity=True senza fase vale Execution."""
    if "activity_phase" in data:
        data["is_activity"] = data["activity_phase"] is not None
    elif "is_activity" in data:
        data["activity_phase"] = "execution" if data["is_activity"] else None
    if data.get("is_activity"):
        data["included_in_codefreeze"] = False
    elif data.get("included_in_codefreeze"):
        data["is_activity"] = False
        data["activity_phase"] = None


def _link_milestone(item: models.BacklogItem, phase_id: int) -> None:
    """Collega la milestone a una fase dello stesso increment: ne prende la
    data e la fase non resta collegata ad altre milestone."""
    db = object_session(item)
    phase = db.get(models.Phase, phase_id)
    if phase is None or phase.project_id != item.project_id:
        raise HTTPException(status_code=400, detail="Fase non trovata in questo increment")
    if not models.is_milestone(item.labels):
        raise HTTPException(status_code=400, detail=f"{item.jira_key} non ha la label Milestone")
    for other in db.query(models.BacklogItem).filter(
        models.BacklogItem.milestone_phase_id == phase_id, models.BacklogItem.id != item.id
    ):
        other.milestone_phase_id = None
    models.align_milestone(item, phase)


def _project_has_baseline(item: models.BacklogItem) -> bool:
    db = object_session(item)
    return (
        db.query(models.BacklogItem.id)
        .filter(models.BacklogItem.project_id == item.project_id, models.BacklogItem.baseline_start.is_not(None))
        .first()
        is not None
    )


def _apply_update(item: models.BacklogItem, data: dict) -> None:
    _normalize_activity(data)
    for field, value in data.items():
        setattr(item, field, value)
    # Item arrivato dopo la baseline dell'increment: la prende la prima volta
    # che viene ripianificato (le date di default non contano come piano).
    if (
        ("planned_start" in data or "expected_finish" in data)
        and item.baseline_start is None
        and "baseline_start" not in data
        and item.planned_start is not None
        and item.expected_finish is not None
        and _project_has_baseline(item)
    ):
        item.baseline_start = item.planned_start
        item.baseline_finish = item.expected_finish
    if data.get("milestone_phase_id") is not None:
        _link_milestone(item, data["milestone_phase_id"])


@router.post("/api/projects/{project_id}/backlog/baseline", response_model=schemas.BaselineResult)
def set_baseline(project_id: int, db: Session = Depends(get_db)):
    """Fissa la baseline: le date pianificate di adesso diventano quelle
    originali di ogni item che le ha (sostituendo una baseline precedente)."""
    _get_project_or_404(db, project_id)
    items = (
        db.query(models.BacklogItem)
        .filter(models.BacklogItem.project_id == project_id, models.BacklogItem.archived_at.is_(None))
        .all()
    )
    baselined = 0
    without_dates = 0
    for item in items:
        if item.planned_start is not None and item.expected_finish is not None:
            item.baseline_start = item.planned_start
            item.baseline_finish = item.expected_finish
            baselined += 1
        else:
            item.baseline_start = None
            item.baseline_finish = None
            if item.in_scope and item.status != "Done":
                without_dates += 1
    db.commit()
    return schemas.BaselineResult(baselined=baselined, without_dates=without_dates)


@router.put("/api/projects/{project_id}/backlog/bulk", response_model=list[schemas.BacklogItem])
def bulk_update_backlog_items(
    project_id: int, payload: list[schemas.BacklogItemBulkUpdate], db: Session = Depends(get_db)
):
    """Aggiorna piu' item in una sola chiamata (azioni in blocco del Backlog:
    riordino, sizing, in scope, codefreeze). Tutto o niente: se anche un solo
    id non appartiene a questo progetto non viene salvato nulla."""
    _get_project_or_404(db, project_id)
    ids = [entry.id for entry in payload]
    by_id = {
        item.id: item
        for item in db.query(models.BacklogItem).filter(
            models.BacklogItem.project_id == project_id, models.BacklogItem.id.in_(ids)
        )
    }
    missing = sorted(set(ids) - set(by_id))
    if missing:
        raise HTTPException(status_code=404, detail=f"Backlog item non trovati in questo progetto: {missing}")

    for entry in payload:
        _apply_update(by_id[entry.id], entry.model_dump(exclude_unset=True, exclude={"id"}))
    db.commit()
    return [by_id[item_id] for item_id in dict.fromkeys(ids)]


@router.put("/api/backlog/{item_id}", response_model=schemas.BacklogItem)
def update_backlog_item(item_id: int, payload: schemas.BacklogItemUpdate, db: Session = Depends(get_db)):
    item = _get_item_or_404(db, item_id)
    _apply_update(item, payload.model_dump(exclude_unset=True))
    db.commit()
    db.refresh(item)
    return item


@router.delete("/api/backlog/{item_id}", status_code=204)
def delete_backlog_item(item_id: int, db: Session = Depends(get_db)):
    item = _get_item_or_404(db, item_id)
    db.delete(item)
    db.commit()


@router.post("/api/projects/{project_id}/backlog/sync", response_model=schemas.SyncResult)
def sync_backlog_from_jira(project_id: int, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    if not project.jira_jql:
        raise HTTPException(status_code=400, detail="Il progetto non ha una JQL configurata")

    jira_settings = db.get(models.AppSettings, SETTINGS_ROW_ID)

    def on_progress(phase: str, done: int, total: int) -> None:
        _sync_progress[project_id] = schemas.SyncProgress(phase=phase, done=done, total=total)

    base_url = (jira_settings.jira_base_url if jira_settings else None) or ""
    email = (jira_settings.jira_email if jira_settings else None) or ""
    api_token = (jira_settings.jira_api_token if jira_settings else None) or ""

    try:
        # Prima di tutto le credenziali: con un token scaduto la ricerca non
        # da' errore ma risponde 200 con zero issue, /myself invece 401.
        test_connection(base_url, email, api_token)
        issues = search_issues(base_url, email, api_token, project.jira_jql, on_progress)
        # Zero issue con un backlog non vuoto e' quasi sempre un problema di
        # Jira o della JQL, non un backlog davvero finito: non si archivia
        # niente, come per i Complaints.
        existing_count = (
            db.query(models.BacklogItem)
            .filter(models.BacklogItem.project_id == project_id, models.BacklogItem.archived_at.is_(None))
            .count()
        )
        if not issues and existing_count > 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Jira non ha restituito nessuna issue: sincronizzazione annullata, il backlog non è stato "
                    "modificato. Verifica che il token Jira in Configurazione non sia scaduto e che la JQL sia corretta."
                ),
            )
        on_progress("saving", len(issues), len(issues))
        backup_database(f"sync-{project.code}")
        return _save_synced_issues(db, project_id, issues)
    except JiraClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except DatabaseBackupError as exc:
        raise HTTPException(status_code=500, detail=f"{exc}. Sincronizzazione annullata.") from exc
    finally:
        _sync_progress.pop(project_id, None)


@router.get("/api/projects/{project_id}/backlog/sync/progress", response_model=schemas.SyncProgress)
def get_sync_progress(project_id: int):
    return _sync_progress.get(project_id) or schemas.SyncProgress(phase="idle")


def apply_default_planning(db: Session, project: models.Project) -> int:
    """PBI in scope, ancora To Do e senza Start pian.: partono dall'inizio
    dell'increment (primo giorno lavorativo da li') e durano il loro Sizing,
    1 giorno se manca. Cosi' compaiono nel Gantt e si posizionano
    trascinandoli. Restituisce quanti item ha pianificato."""
    start = project.start_date
    if start is None:
        return 0
    off = db.query(models.NonWorkingDay).filter(models.NonWorkingDay.project_id == project.id).all()

    def working(day: dt.date) -> bool:
        return day.weekday() < 5 and not any(r.start_date <= day <= r.end_date for r in off)

    def add_working_days(first: dt.date, days: int) -> dt.date:
        # Stessa regola di addWorkingDays (frontend/src/lib/scheduling.ts):
        # days giorni lavorativi, estremi inclusi.
        day, remaining = first, days - 1
        while remaining > 0:
            day += dt.timedelta(days=1)
            if working(day):
                remaining -= 1
        return day

    while not working(start):
        start += dt.timedelta(days=1)
    planned = 0
    items = db.query(models.BacklogItem).filter(
        models.BacklogItem.project_id == project.id,
        models.BacklogItem.archived_at.is_(None),
        models.BacklogItem.in_scope.is_(True),
        models.BacklogItem.planned_start.is_(None),
    )
    for item in items:
        if item.status != "To Do":
            continue
        if not item.planned_duration_days or item.planned_duration_days <= 0:
            item.planned_duration_days = 1
        item.planned_start = start
        item.expected_finish = add_working_days(start, max(1, round(item.planned_duration_days)))
        planned += 1
    return planned


def _save_synced_issues(db: Session, project_id: int, issues: list[JiraIssue]) -> schemas.SyncResult:
    """Allinea gli item del backlog alle issue lette da Jira: crea le nuove,
    aggiorna le esistenti (riportando nel backlog quelle archiviate), archivia
    quelle non piu' nella JQL."""

    existing = {
        item.jira_key: item
        for item in db.query(models.BacklogItem).filter(models.BacklogItem.project_id == project_id)
    }

    created = 0
    updated = 0
    restored = 0
    now = dt.datetime.utcnow()
    max_order = max((item.priority_order for item in existing.values()), default=0)
    matched_keys = {issue.key for issue in issues}

    for issue in issues:
        labels = ";".join(issue.labels)
        implemented_by_json = json.dumps(issue.implemented_by) if issue.implemented_by else None
        if issue.key in existing:
            item = existing[issue.key]
            item.summary = issue.summary
            item.description = issue.description
            item.change_description = issue.change_description
            item.problem_cause = issue.problem_cause
            item.components = issue.components
            item.dev_effort_hours = issue.dev_effort_hours
            item.impacts_on = issue.impacts_on
            item.assignee = issue.assignee
            item.issue_type = issue.issue_type
            item.jira_status = issue.status
            item.labels = labels
            item.parent_key = issue.parent_key
            item.parent_summary = issue.parent_summary
            item.implemented_by_json = implemented_by_json
            item.logged_hours = issue.logged_hours
            item.actual_start = issue.actual_start
            item.actual_finish = issue.actual_finish
            item.last_synced_at = now
            # Una milestone non e' lavoro del team: sempre fuori dal code freeze.
            if models.is_milestone(issue.labels):
                item.included_in_codefreeze = False
            if item.archived_at is not None:
                item.archived_at = None
                restored += 1
            updated += 1
        else:
            max_order += 1
            item = models.BacklogItem(
                project_id=project_id,
                jira_key=issue.key,
                priority_order=max_order,
                summary=issue.summary,
                description=issue.description,
                change_description=issue.change_description,
                problem_cause=issue.problem_cause,
                components=issue.components,
                dev_effort_hours=issue.dev_effort_hours,
                impacts_on=issue.impacts_on,
                assignee=issue.assignee,
                issue_type=issue.issue_type,
                jira_status=issue.status,
                labels=labels,
                parent_key=issue.parent_key,
                parent_summary=issue.parent_summary,
                implemented_by_json=implemented_by_json,
                logged_hours=issue.logged_hours,
                actual_start=issue.actual_start,
                actual_finish=issue.actual_finish,
                last_synced_at=now,
                # Solo alla creazione: dopo, il flag e' dell'utente.
                included_in_codefreeze=not (
                    models.is_cve_bug(issue.issue_type, issue.summary) or models.is_milestone(issue.labels)
                ),
            )
            db.add(item)
            created += 1

    # Archivia gli item sincronizzati in precedenza che non sono piu' nel
    # risultato della JQL (es. fix version cambiata su Jira): altrimenti
    # resterebbero nel backlog per sempre, invisibili alla sync. Non si
    # cancellano: vedi BacklogItem.archived_at.
    removed = 0
    for jira_key, item in existing.items():
        if jira_key not in matched_keys and item.archived_at is None:
            item.archived_at = now
            removed += 1

    # Gli item da fare senza date compaiono nel Gantt dall'inizio dell'increment.
    db.flush()
    # Milestone collegate a una fase: chiuse su Jira passano alla data effettiva.
    for item in db.query(models.BacklogItem).filter(
        models.BacklogItem.project_id == project_id, models.BacklogItem.milestone_phase_id.is_not(None)
    ):
        phase = db.get(models.Phase, item.milestone_phase_id)
        if phase is not None:
            models.align_milestone(item, phase)
    apply_default_planning(db, db.get(models.Project, project_id))
    db.commit()
    return schemas.SyncResult(
        created=created, updated=updated, removed=removed, restored=restored, total_matched=len(issues)
    )
