import datetime as dt
import json
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import SessionLocal, get_db
from app.services.metrics import (
    TEAM_LABELS,
    compute_bugs_opened_metrics,
    compute_cycle_time_metrics,
    compute_overview_metrics,
)

router = APIRouter(tags=["dashboard-snapshots"])


def _collect_team_data(team: str) -> schemas.DashboardSnapshotTeamData:
    # Sessione propria: i due team sono raccolti in parallelo (il Cycle Time
    # legge il changelog di ogni PBI ed e' la parte lenta), e una Session
    # SQLAlchemy non va condivisa tra thread.
    db = SessionLocal()
    try:
        return schemas.DashboardSnapshotTeamData(
            overview_current=compute_overview_metrics(db, team, "current"),
            overview_previous=compute_overview_metrics(db, team, "previous"),
            cycle_time=compute_cycle_time_metrics(db, team),
            bugs_opened=compute_bugs_opened_metrics(db, team),
        )
    finally:
        db.close()


def _has_errors(teams: dict[str, schemas.DashboardSnapshotTeamData]) -> bool:
    return any(
        chart.error
        for data in teams.values()
        for chart in (data.overview_current, data.overview_previous, data.cycle_time, data.bugs_opened)
    )


def _load_teams(snapshot: models.DashboardSnapshot) -> dict[str, schemas.DashboardSnapshotTeamData]:
    raw = json.loads(snapshot.data_json)
    return {team: schemas.DashboardSnapshotTeamData.model_validate(data) for team, data in raw.items()}


def _summary(snapshot: models.DashboardSnapshot) -> schemas.DashboardSnapshotSummary:
    return schemas.DashboardSnapshotSummary(
        id=snapshot.id,
        snapshot_date=snapshot.snapshot_date,
        created_at=snapshot.created_at,
        note=snapshot.note,
        has_errors=_has_errors(_load_teams(snapshot)),
    )


def _get_or_404(db: Session, snapshot_id: int) -> models.DashboardSnapshot:
    snapshot = db.get(models.DashboardSnapshot, snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Snapshot non trovato")
    return snapshot


@router.get("/api/dashboard/snapshots", response_model=list[schemas.DashboardSnapshotSummary])
def list_dashboard_snapshots(db: Session = Depends(get_db)):
    snapshots = (
        db.query(models.DashboardSnapshot)
        .order_by(models.DashboardSnapshot.snapshot_date.desc(), models.DashboardSnapshot.id.desc())
        .all()
    )
    return [_summary(s) for s in snapshots]


@router.get("/api/dashboard/snapshots/{snapshot_id}", response_model=schemas.DashboardSnapshotDetail)
def get_dashboard_snapshot(snapshot_id: int, db: Session = Depends(get_db)):
    snapshot = _get_or_404(db, snapshot_id)
    teams = _load_teams(snapshot)
    return schemas.DashboardSnapshotDetail(**_summary(snapshot).model_dump(), teams=teams)


@router.post("/api/dashboard/snapshots", response_model=schemas.DashboardSnapshotSummary, status_code=201)
def create_dashboard_snapshot(payload: schemas.DashboardSnapshotCreate, db: Session = Depends(get_db)):
    """Interroga Jira ora, per tutti i team, con le stesse funzioni dei
    grafici live, e salva il risultato. La data dello snapshot e' sempre
    oggi: le finestre dei grafici ("ultimi 365 giorni") sono relative al
    momento della raccolta, quindi non si puo' fotografare una data
    passata."""
    with ThreadPoolExecutor(max_workers=len(TEAM_LABELS)) as pool:
        teams = dict(zip(TEAM_LABELS, pool.map(_collect_team_data, TEAM_LABELS)))

    snapshot = models.DashboardSnapshot(
        snapshot_date=dt.date.today(),
        note=(payload.note or "").strip() or None,
        data_json=json.dumps({team: data.model_dump(mode="json") for team, data in teams.items()}),
    )
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return _summary(snapshot)


@router.put("/api/dashboard/snapshots/{snapshot_id}", response_model=schemas.DashboardSnapshotSummary)
def update_dashboard_snapshot(
    snapshot_id: int, payload: schemas.DashboardSnapshotUpdate, db: Session = Depends(get_db)
):
    snapshot = _get_or_404(db, snapshot_id)
    snapshot.note = (payload.note or "").strip() or None
    db.commit()
    db.refresh(snapshot)
    return _summary(snapshot)


@router.delete("/api/dashboard/snapshots/{snapshot_id}", status_code=204)
def delete_dashboard_snapshot(snapshot_id: int, db: Session = Depends(get_db)):
    snapshot = _get_or_404(db, snapshot_id)
    db.delete(snapshot)
    db.commit()
