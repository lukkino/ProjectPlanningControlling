from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db

router = APIRouter(tags=["snapshots"])


def _get_project_or_404(db: Session, project_id: int) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return project


@router.get("/api/projects/{project_id}/snapshots", response_model=list[schemas.Snapshot])
def list_snapshots(project_id: int, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    return (
        db.query(models.Snapshot)
        .filter(models.Snapshot.project_id == project_id)
        .order_by(models.Snapshot.snapshot_date)
        .all()
    )


@router.post("/api/projects/{project_id}/snapshots", response_model=schemas.Snapshot, status_code=201)
def create_snapshot(project_id: int, payload: schemas.SnapshotCreate, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    snapshot = models.Snapshot(project_id=project_id, **payload.model_dump())
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return snapshot


@router.put("/api/snapshots/{snapshot_id}", response_model=schemas.Snapshot)
def update_snapshot(snapshot_id: int, payload: schemas.SnapshotUpdate, db: Session = Depends(get_db)):
    snapshot = db.get(models.Snapshot, snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Snapshot non trovato")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(snapshot, field, value)
    db.commit()
    db.refresh(snapshot)
    return snapshot


@router.delete("/api/snapshots/{snapshot_id}", status_code=204)
def delete_snapshot(snapshot_id: int, db: Session = Depends(get_db)):
    snapshot = db.get(models.Snapshot, snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Snapshot non trovato")
    db.delete(snapshot)
    db.commit()
