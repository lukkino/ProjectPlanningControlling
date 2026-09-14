from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.metrics import compute_dashboard_metrics

router = APIRouter(tags=["dashboard"])


@router.get("/api/projects/{project_id}/dashboard", response_model=schemas.DashboardMetrics)
def get_dashboard(project_id: int, db: Session = Depends(get_db)):
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return compute_dashboard_metrics(project)
