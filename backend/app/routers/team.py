"""Team del Carico team: ruoli (Project Manager, Developer...), persone con
le ore lavorative al giorno e le assenze (ferie, malattia). Personale per
utente, vale per tutti gli increment: il Carico per assegnatario lo usa per
le ore davvero disponibili (vedi services/workload.py)."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.ownership import scope_user_id

router = APIRouter(prefix="/api/team", tags=["team"])

# Ruoli proposti al primo utilizzo (si possono rinominare o togliere).
DEFAULT_ROLES = ["Project Manager", "Developer", "Tester"]


class RoleCreate(BaseModel):
    name: str


class ResourceCreate(BaseModel):
    name: str
    hours_per_day: float = 8


def _roles(db: Session):
    return db.query(models.TeamRole).filter(models.TeamRole.owner_id == scope_user_id())


def _get(db: Session, model, item_id: int, label: str):
    obj = db.get(model, item_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"{label} non trovato")
    return obj


def _check_name(name: str) -> str:
    name = " ".join(name.split())
    if not name:
        raise HTTPException(status_code=400, detail="Il nome non può essere vuoto")
    return name


def _check_hours(hours: float) -> float:
    if not 0 < hours <= 24:
        raise HTTPException(status_code=400, detail="Le ore al giorno devono essere tra 0 e 24")
    return hours


@router.get("", response_model=list[schemas.TeamRole])
def list_team(db: Session = Depends(get_db)):
    return _roles(db).order_by(models.TeamRole.order, models.TeamRole.id).all()


@router.post("/roles", response_model=schemas.TeamRole)
def create_role(payload: RoleCreate, db: Session = Depends(get_db)):
    order = max((r.order for r in _roles(db)), default=-1) + 1
    role = models.TeamRole(owner_id=scope_user_id(), name=_check_name(payload.name), order=order)
    db.add(role)
    db.commit()
    db.refresh(role)
    return role


@router.post("/roles/defaults", response_model=list[schemas.TeamRole])
def create_default_roles(db: Session = Depends(get_db)):
    """Crea i ruoli proposti che mancano (primo utilizzo)."""
    existing = {r.name.casefold() for r in _roles(db)}
    order = max((r.order for r in _roles(db)), default=-1)
    for name in DEFAULT_ROLES:
        if name.casefold() not in existing:
            order += 1
            db.add(models.TeamRole(owner_id=scope_user_id(), name=name, order=order))
    db.commit()
    return list_team(db)


@router.put("/roles/{role_id}", response_model=schemas.TeamRole)
def update_role(role_id: int, payload: schemas.TeamRoleUpdate, db: Session = Depends(get_db)):
    role = _get(db, models.TeamRole, role_id, "Ruolo")
    if payload.name is not None:
        role.name = _check_name(payload.name)
    if payload.order is not None:
        role.order = payload.order
    db.commit()
    db.refresh(role)
    return role


@router.delete("/roles/{role_id}", status_code=204)
def delete_role(role_id: int, db: Session = Depends(get_db)):
    db.delete(_get(db, models.TeamRole, role_id, "Ruolo"))
    db.commit()


@router.post("/roles/{role_id}/resources", response_model=schemas.TeamResource)
def create_resource(role_id: int, payload: ResourceCreate, db: Session = Depends(get_db)):
    role = _get(db, models.TeamRole, role_id, "Ruolo")
    name = _check_name(payload.name)
    # Una persona sola per nome: e' la chiave che la collega agli item Jira.
    for other in _roles(db):
        if any(r.name.casefold() == name.casefold() for r in other.resources):
            raise HTTPException(status_code=400, detail=f"{name} è già nel team (ruolo {other.name})")
    resource = models.TeamResource(
        role_id=role.id,
        name=name,
        hours_per_day=_check_hours(payload.hours_per_day),
        order=max((r.order for r in role.resources), default=-1) + 1,
    )
    db.add(resource)
    db.commit()
    db.refresh(resource)
    return resource


@router.put("/resources/{resource_id}", response_model=schemas.TeamResource)
def update_resource(resource_id: int, payload: schemas.TeamResourceUpdate, db: Session = Depends(get_db)):
    resource = _get(db, models.TeamResource, resource_id, "Persona")
    if payload.name is not None:
        resource.name = _check_name(payload.name)
    if payload.hours_per_day is not None:
        resource.hours_per_day = _check_hours(payload.hours_per_day)
    if payload.role_id is not None and payload.role_id != resource.role_id:
        role = _get(db, models.TeamRole, payload.role_id, "Ruolo")
        if role.owner_id != scope_user_id():
            raise HTTPException(status_code=404, detail="Ruolo non trovato")
        resource.role_id = role.id
    if payload.order is not None:
        resource.order = payload.order
    db.commit()
    db.refresh(resource)
    return resource


@router.delete("/resources/{resource_id}", status_code=204)
def delete_resource(resource_id: int, db: Session = Depends(get_db)):
    db.delete(_get(db, models.TeamResource, resource_id, "Persona"))
    db.commit()


@router.post("/resources/{resource_id}/absences", response_model=schemas.TeamAbsence)
def add_absence(resource_id: int, payload: schemas.TeamAbsenceCreate, db: Session = Depends(get_db)):
    resource = _get(db, models.TeamResource, resource_id, "Persona")
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail="La fine dell'assenza è prima dell'inizio")
    absence = models.TeamResourceAbsence(resource_id=resource.id, **payload.model_dump())
    db.add(absence)
    db.commit()
    db.refresh(absence)
    return absence


@router.delete("/absences/{absence_id}", status_code=204)
def delete_absence(absence_id: int, db: Session = Depends(get_db)):
    db.delete(_get(db, models.TeamResourceAbsence, absence_id, "Assenza"))
    db.commit()
