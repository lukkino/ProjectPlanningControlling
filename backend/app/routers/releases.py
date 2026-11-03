from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.releases import export_releases

router = APIRouter(prefix="/api/releases", tags=["releases"])


def _list(db: Session) -> list[models.Release]:
    return db.query(models.Release).order_by(models.Release.sort_order, models.Release.id).all()


def _get_release_or_404(db: Session, release_id: int) -> models.Release:
    release = db.get(models.Release, release_id)
    if release is None:
        raise HTTPException(status_code=404, detail="Release non trovata")
    return release


def _get_component_or_404(db: Session, component_id: int) -> models.ReleaseComponent:
    component = db.get(models.ReleaseComponent, component_id)
    if component is None:
        raise HTTPException(status_code=404, detail="Componente non trovato")
    return component


@router.get("", response_model=list[schemas.ReleaseRead])
def list_releases(db: Session = Depends(get_db)):
    return _list(db)


@router.get("/export")
def export_to_excel(db: Session = Depends(get_db)):
    """Le release in un file .xlsx con le stesse colonne del foglio PTBSYS-03."""
    return Response(
        content=export_releases(_list(db)),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="PTBSYS-03 releases.xlsx"'},
    )


@router.post("", response_model=schemas.ReleaseRead, status_code=201)
def create_release(payload: schemas.ReleaseWrite, db: Session = Depends(get_db)):
    last = db.query(func.max(models.Release.sort_order)).scalar() or 0
    release = models.Release(**payload.model_dump(), sort_order=last + 1)
    db.add(release)
    db.commit()
    db.refresh(release)
    return release


@router.put("/{release_id}", response_model=schemas.ReleaseRead)
def update_release(release_id: int, payload: schemas.ReleaseWrite, db: Session = Depends(get_db)):
    release = _get_release_or_404(db, release_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(release, field, value)
    db.commit()
    db.refresh(release)
    return release


@router.delete("/{release_id}", status_code=204)
def delete_release(release_id: int, db: Session = Depends(get_db)):
    db.delete(_get_release_or_404(db, release_id))
    db.commit()


@router.post("/{release_id}/components", response_model=schemas.ReleaseComponentRead, status_code=201)
def create_component(release_id: int, payload: schemas.ReleaseComponentWrite, db: Session = Depends(get_db)):
    release = _get_release_or_404(db, release_id)
    last = max((component.sort_order for component in release.components), default=0)
    component = models.ReleaseComponent(**payload.model_dump(), release_id=release.id, sort_order=last + 1)
    db.add(component)
    db.commit()
    db.refresh(component)
    return component


@router.put("/components/{component_id}", response_model=schemas.ReleaseComponentRead)
def update_component(component_id: int, payload: schemas.ReleaseComponentWrite, db: Session = Depends(get_db)):
    component = _get_component_or_404(db, component_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(component, field, value)
    db.commit()
    db.refresh(component)
    return component


@router.delete("/components/{component_id}", status_code=204)
def delete_component(component_id: int, db: Session = Depends(get_db)):
    db.delete(_get_component_or_404(db, component_id))
    db.commit()
