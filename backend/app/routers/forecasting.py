from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.ownership import user_settings, user_settings_for_update
from app.routers.settings import SETTINGS_ROW_ID
from app.services.jira_client import JiraClientError, fetch_created_and_status

from app import models, schemas
from app.database import get_db

router = APIRouter(tags=["forecasting"])

# Segnaposto delle JQL dei PBI Done: l'Inizio sviluppi effettivo (o il
# Project start) nel formato delle date JQL.
DEV_START_PLACEHOLDER = "{inizio_sviluppi}"


def _resolve_done_jql(project: models.Project, jql: str | None) -> str | None:
    jql = (jql or "").strip()
    if not jql:
        return None
    if DEV_START_PLACEHOLDER in jql:
        start = project.dev_start_date or project.start_date
        if start is None:
            raise HTTPException(
                status_code=400,
                detail="La JQL usa {inizio_sviluppi} ma l'increment non ha né Inizio sviluppi effettivo né Project start.",
            )
        jql = jql.replace(DEV_START_PLACEHOLDER, start.strftime("%Y/%m/%d"))
    return jql


@router.get("/api/forecasting/defaults/done-jql", response_model=schemas.DoneJqlDefaults)
def get_done_jql_defaults(db: Session = Depends(get_db)):
    row = user_settings(db)
    return schemas.DoneJqlDefaults(planned_done_jql=row.planned_done_jql, unplanned_done_jql=row.unplanned_done_jql)


@router.put("/api/forecasting/defaults/done-jql", response_model=schemas.DoneJqlDefaults)
def update_done_jql_defaults(payload: schemas.DoneJqlDefaults, db: Session = Depends(get_db)):
    row = user_settings_for_update(db)
    row.planned_done_jql = (payload.planned_done_jql or "").strip() or None
    row.unplanned_done_jql = (payload.unplanned_done_jql or "").strip() or None
    db.commit()
    return schemas.DoneJqlDefaults(planned_done_jql=row.planned_done_jql, unplanned_done_jql=row.unplanned_done_jql)


@router.get("/api/projects/{project_id}/forecasting/done-counts", response_model=schemas.DoneCounts)
def get_done_counts(project_id: int, db: Session = Depends(get_db)):
    """Planned e Unplanned PBI Done dalle JQL dell'increment (come nel
    foglio Excel), per una nuova simulazione. Una JQL vuota da' keys=None:
    allora il frontend usa il criterio delle label."""
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Increment non trovato")
    settings = db.get(models.AppSettings, SETTINGS_ROW_ID)
    # JQL dell'increment se c'e', se no quella predefinita del proprietario.
    defaults = user_settings(db, project.owner_id) if project.owner_id else None
    result = {}
    for name in ("planned", "unplanned"):
        own = getattr(project, f"{name}_done_jql")
        default = getattr(defaults, f"{name}_done_jql", None) if defaults else None
        source = "increment" if (own or "").strip() else ("default" if (default or "").strip() else None)
        jql = _resolve_done_jql(project, own if source == "increment" else default)
        if jql is None:
            result[name] = schemas.DoneJqlResult()
            continue
        try:
            issues = fetch_created_and_status(
                (settings.jira_base_url if settings else None) or "",
                (settings.jira_email if settings else None) or "",
                (settings.jira_api_token if settings else None) or "",
                jql,
            )
        except JiraClientError as exc:
            label = "Planned" if name == "planned" else "Unplanned"
            raise HTTPException(status_code=502, detail=f"JQL {label} PBI Done: {exc}") from exc
        result[name] = schemas.DoneJqlResult(keys=list(issues), jql=jql, source=source)
    return schemas.DoneCounts(**result)


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
