import datetime as dt
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.ownership import scope_user_id
from app.services.metrics import (
    compute_bugs_opened_metrics,
    compute_cycle_time_metrics,
    compute_dashboard_metrics,
    compute_overview_metrics,
)
from app.services.cycle_time_file import CycleTimeFileError, parse_cycle_time_file
from app.services.earned_value import compute_earned_value
from app.services.workload import TeamPerson, compute_workload, team_key
from app.services.presentation import generate_dashboard_presentation

router = APIRouter(tags=["dashboard"])

Team = Literal["sw", "embedded"]
Period = Literal["current", "previous"]

# Avanzamento dell'estrazione Cycle Time in corso, per team (un changelog per
# issue: lenta), letto dal popup di Monte Carlo come per la sync Backlog.
_cycle_time_progress: dict[str, schemas.SyncProgress] = {}


@router.get("/api/projects/{project_id}/dashboard", response_model=schemas.DashboardMetrics)
def get_dashboard(project_id: int, db: Session = Depends(get_db)):
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return compute_dashboard_metrics(project)


@router.get("/api/projects/{project_id}/earned-value", response_model=schemas.EarnedValue)
def get_earned_value(project_id: int, db: Session = Depends(get_db)):
    """Earned Value dell'increment (regole in services/earned_value.py)."""
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    ev = compute_earned_value(project)
    return schemas.EarnedValue(
        **{k: v for k, v in ev.__dict__.items() if k not in ("items", "curve")},
        sv=ev.sv,
        cv=ev.cv,
        items=[schemas.EarnedValueItem(**i.__dict__, sv=i.sv, cpi=i.cpi) for i in ev.items],
        curve=[schemas.EarnedValuePoint(**p.__dict__) for p in ev.curve],
    )


@router.get("/api/workload", response_model=schemas.Workload)
def get_workload(
    weeks: int = Query(12, ge=1, le=52),
    project_ids: list[int] | None = Query(None, description="Solo questi increment (default: tutti)"),
    db: Session = Depends(get_db),
):
    """Carico per assegnatario su tutti gli increment dell'utente (regole in
    services/workload.py)."""
    query = db.query(models.Project).filter(models.Project.owner_id == scope_user_id())
    if project_ids:
        query = query.filter(models.Project.id.in_(project_ids))
    projects = sorted(query.all(), key=lambda p: (p.gantt_order is None, p.gantt_order or 0, p.name))
    roles = db.query(models.TeamRole).filter(models.TeamRole.owner_id == scope_user_id()).all()
    team = {
        team_key(r.name): TeamPerson(
            role=role.name,
            hours_per_day=r.hours_per_day,
            absences=[(a.start_date, a.end_date) for a in r.absences],
        )
        for role in roles
        for r in role.resources
    }
    load = compute_workload(projects, weeks=weeks, team=team)
    return schemas.Workload(
        today=load.today,
        week_starts=load.week_starts,
        projects=[
            schemas.WorkloadProject(
                id=p.id,
                name=p.name,
                code=p.code,
                has_jql=bool(p.jira_jql),
                last_synced_at=max((i.last_synced_at for i in p.backlog_items if i.last_synced_at), default=None),
            )
            for p in projects
        ],
        assignees=[
            schemas.WorkloadAssignee(
                **{k: v for k, v in a.__dict__.items() if k != "items"},
                items=[schemas.WorkloadItem(**i.__dict__) for i in a.items],
            )
            for a in load.assignees
        ],
    )


@router.get("/api/projects/{project_id}/dashboard/presentation")
def download_dashboard_presentation(
    project_id: int,
    days: int = Query(7, ge=1, le=365, description="Periodo della card Issue chiuse, in giorni"),
    db: Session = Depends(get_db),
):
    """Presentazione PowerPoint coi dati della Dashboard dell'increment."""
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    content, filename_stem = generate_dashboard_presentation(project, days)
    filename = re.sub(r"[^\w\-. ()+]", "_", filename_stem, flags=re.ASCII)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f'attachment; filename="{filename}.pptx"'},
    )


def _cycle_time_key(team: str) -> str:
    """Ultima estrazione Cycle Time salvata: per utente (ognuno ha le sue JQL)."""
    return f"cycle-time:{scope_user_id()}:{team}"


@router.get("/api/dashboard/overview", response_model=schemas.OverviewMetrics)
def get_overview_dashboard(team: Team = "sw", period: Period = "current", db: Session = Depends(get_db)):
    return compute_overview_metrics(db, team, period)


@router.get("/api/dashboard/cycle-time", response_model=schemas.CycleTimeMetrics)
def get_cycle_time_dashboard(
    team: Team = "sw",
    since: dt.date | None = Query(None, description="Estrae da questa data se e' oltre gli ultimi 12 mesi"),
    db: Session = Depends(get_db),
):
    def on_progress(phase: str, done: int, total: int) -> None:
        _cycle_time_progress[team] = schemas.SyncProgress(phase=phase, done=done, total=total)

    try:
        metrics = compute_cycle_time_metrics(db, team, on_progress, since)
    finally:
        _cycle_time_progress.pop(team, None)
    # Solo un'estrazione riuscita sostituisce quella salvata.
    if not metrics.error:
        metrics.fetched_at = dt.datetime.utcnow()
        cached = db.get(models.CachedExtraction, _cycle_time_key(team)) or models.CachedExtraction(
            key=_cycle_time_key(team)
        )
        cached.payload = metrics.model_dump_json()
        cached.fetched_at = metrics.fetched_at
        db.add(cached)
        db.commit()
    return metrics


@router.post("/api/dashboard/cycle-time/import", response_model=schemas.CycleTimeMetrics)
def import_cycle_time(payload: schemas.CycleTimeImport, team: Team = "sw", db: Session = Depends(get_db)):
    """Storico da un file pre-elaborato (CSV) invece che da Jira: stessi
    punti e percentili, salvati come ultima estrazione del team (Monte Carlo,
    Forecasting e Dashboard generale li usano allo stesso modo)."""
    try:
        metrics = parse_cycle_time_file(payload.content)
    except CycleTimeFileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    metrics.fetched_at = dt.datetime.utcnow()
    metrics.source = payload.filename.rsplit("\\", 1)[-1].rsplit("/", 1)[-1][:200] or "file"
    cached = db.get(models.CachedExtraction, _cycle_time_key(team)) or models.CachedExtraction(key=_cycle_time_key(team))
    cached.payload = metrics.model_dump_json()
    cached.fetched_at = metrics.fetched_at
    db.add(cached)
    db.commit()
    return metrics


@router.get("/api/dashboard/cycle-time/cached", response_model=schemas.CycleTimeMetrics | None)
def get_cached_cycle_time(team: Team = "sw", db: Session = Depends(get_db)):
    """Ultima estrazione Cycle Time salvata (null se mai fatta): Monte Carlo
    e Forecasting la mostrano subito, senza ripetere l'estrazione lenta."""
    cached = db.get(models.CachedExtraction, _cycle_time_key(team))
    return schemas.CycleTimeMetrics.model_validate_json(cached.payload) if cached else None


@router.get("/api/dashboard/cycle-time/progress", response_model=schemas.SyncProgress)
def get_cycle_time_progress(team: Team = "sw"):
    return _cycle_time_progress.get(team) or schemas.SyncProgress(phase="idle")


@router.get("/api/dashboard/bugs-opened", response_model=schemas.BugsOpenedMetrics)
def get_bugs_opened_dashboard(team: Team = "sw", db: Session = Depends(get_db)):
    return compute_bugs_opened_metrics(db, team)
