import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.metrics import (
    compute_bugs_opened_metrics,
    compute_cycle_time_metrics,
    compute_dashboard_metrics,
    compute_overview_metrics,
)
from app.services.presentation import generate_dashboard_presentation

router = APIRouter(tags=["dashboard"])

Team = Literal["sw", "embedded"]
Period = Literal["current", "previous"]


@router.get("/api/projects/{project_id}/dashboard", response_model=schemas.DashboardMetrics)
def get_dashboard(project_id: int, db: Session = Depends(get_db)):
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return compute_dashboard_metrics(project)


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


@router.get("/api/dashboard/overview", response_model=schemas.OverviewMetrics)
def get_overview_dashboard(team: Team = "sw", period: Period = "current", db: Session = Depends(get_db)):
    return compute_overview_metrics(db, team, period)


@router.get("/api/dashboard/cycle-time", response_model=schemas.CycleTimeMetrics)
def get_cycle_time_dashboard(team: Team = "sw", db: Session = Depends(get_db)):
    return compute_cycle_time_metrics(db, team)


@router.get("/api/dashboard/bugs-opened", response_model=schemas.BugsOpenedMetrics)
def get_bugs_opened_dashboard(team: Team = "sw", db: Session = Depends(get_db)):
    return compute_bugs_opened_metrics(db, team)
