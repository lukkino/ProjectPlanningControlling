from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.metrics import compute_cycle_time_metrics, compute_dashboard_metrics, compute_overview_metrics

router = APIRouter(tags=["dashboard"])

Team = Literal["sw", "embedded"]


@router.get("/api/projects/{project_id}/dashboard", response_model=schemas.DashboardMetrics)
def get_dashboard(project_id: int, db: Session = Depends(get_db)):
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return compute_dashboard_metrics(project)


@router.get("/api/dashboard/overview", response_model=schemas.OverviewMetrics)
def get_overview_dashboard(team: Team = "sw", db: Session = Depends(get_db)):
    return compute_overview_metrics(db, team)


@router.get("/api/dashboard/cycle-time", response_model=schemas.CycleTimeMetrics)
def get_cycle_time_dashboard(team: Team = "sw", db: Session = Depends(get_db)):
    return compute_cycle_time_metrics(db, team)
