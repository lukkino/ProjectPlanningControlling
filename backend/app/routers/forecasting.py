from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db

router = APIRouter(tags=["forecasting"])


def _get_project_or_404(db: Session, project_id: int) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return project


def _get_simulation_or_404(db: Session, sim_id: int) -> models.ForecastSimulation:
    sim = db.get(models.ForecastSimulation, sim_id)
    if sim is None:
        raise HTTPException(status_code=404, detail="Simulazione non trovata")
    return sim


@router.get("/api/projects/{project_id}/forecasting", response_model=list[schemas.ForecastSimulation])
def list_simulations(project_id: int, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    return (
        db.query(models.ForecastSimulation)
        .filter(models.ForecastSimulation.project_id == project_id)
        .order_by(models.ForecastSimulation.id)
        .all()
    )


@router.post("/api/projects/{project_id}/forecasting", response_model=schemas.ForecastSimulation, status_code=201)
def create_simulation(project_id: int, payload: schemas.ForecastSimulationCreate, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    sim = models.ForecastSimulation(project_id=project_id, **payload.model_dump())
    db.add(sim)
    db.commit()
    db.refresh(sim)
    return sim


@router.put("/api/forecasting/{sim_id}", response_model=schemas.ForecastSimulation)
def update_simulation(sim_id: int, payload: schemas.ForecastSimulationUpdate, db: Session = Depends(get_db)):
    sim = _get_simulation_or_404(db, sim_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(sim, field, value)
    db.commit()
    db.refresh(sim)
    return sim


@router.delete("/api/forecasting/{sim_id}", status_code=204)
def delete_simulation(sim_id: int, db: Session = Depends(get_db)):
    sim = _get_simulation_or_404(db, sim_id)
    db.delete(sim)
    db.commit()
