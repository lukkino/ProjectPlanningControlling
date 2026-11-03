from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.releases import export_releases

router = APIRouter(prefix="/api/releases", tags=["releases"])


def _project_ptih_codes(project: models.Project) -> str | None:
    """Codici PTIH dei progetti collegati per intero all'increment."""
    return ", ".join(p.code for p in project.progetti) or None


# Date della release che stanno nell'increment (Project): per le release di
# un increment dell'app sono sempre le sue, e in Releases non si modificano.
PROJECT_DATE_FIELDS = ("start_date", "expected_release_date", "actual_release_date")


RELEASE_TO_MARKET = "Release to Market"


def _project_dates(project: models.Project) -> dict:
    """Start Date: l'inizio dell'increment. Expected e Actual Release: la
    data Aggiornata e quella Effettiva della fase Release to Market (per
    l'Actual, in mancanza, la data in cui l'increment e' segnato rilasciato)."""
    rtm = next((phase for phase in project.phases if phase.name == RELEASE_TO_MARKET), None)
    return {
        "start_date": project.start_date,
        "expected_release_date": rtm.planned_date if rtm else None,
        "actual_release_date": (rtm.actual_date if rtm else None) or project.release_date,
    }


def sync_release_from_project(release: models.Release, project: models.Project) -> None:
    """Riporta sulla release i dati dell'increment. Le date sempre; Project ID
    e Change Order solo se valorizzati sull'increment, per non cancellare
    quanto gia' scritto nella release (es. i dati importati dal foglio)."""
    for field, value in _project_dates(project).items():
        setattr(release, field, value)
    for field, value in {"ptih_code": _project_ptih_codes(project), "change_order": project.change_order_label}.items():
        if value is not None:
            setattr(release, field, value)


def _add_missing_project_releases(db: Session) -> None:
    """Ogni increment dell'app ha la sua release: se manca la si crea vuota,
    col solo codice, in fondo. Si riempie compilando i componenti dalla tab
    "Components & PN" dell'increment (vedi increment_components.py)."""
    existing = {code for (code,) in db.query(models.Release.increment_code) if code}
    missing = [project for project in db.query(models.Project).order_by(models.Project.code) if project.code not in existing]
    if not missing:
        return
    last = db.query(func.max(models.Release.sort_order)).scalar() or 0
    for offset, project in enumerate(missing, 1):
        db.add(models.Release(increment_code=project.code, sort_order=last + offset))
    db.commit()


def _fill_missing_ptih_codes(db: Session) -> None:
    """Project ID vuoto: lo si prende dal progetto collegato all'increment
    nella sua tab Progetti, se c'e'. Quello gia' scritto non si tocca."""
    projects = {project.code: project for project in db.query(models.Project)}
    changed = False
    for release in db.query(models.Release).filter(models.Release.ptih_code.is_(None)):
        project = projects.get(release.increment_code)
        codes = _project_ptih_codes(project) if project else None
        if codes:
            release.ptih_code = codes
            changed = True
    if changed:
        db.commit()


def _sync_project_dates(db: Session) -> None:
    """Allinea le date delle release a quelle dei loro increment."""
    projects = {project.code: project for project in db.query(models.Project)}
    changed = False
    for release in db.query(models.Release):
        project = projects.get(release.increment_code)
        if project is None:
            continue
        for field, value in _project_dates(project).items():
            if getattr(release, field) != value:
                setattr(release, field, value)
                changed = True
    if changed:
        db.commit()


def _mark_project_releases(db: Session, releases: list[models.Release]) -> list[models.Release]:
    """Attributi non salvati sulle release di un increment dell'app:
    project_id (la pagina ne mostra le date in sola lettura) e
    scope_narrative, lo scopo discorsivo dell'increment che, se c'e', fa da
    Scopo al posto di quello scritto nella release."""
    projects = {project.code: project for project in db.query(models.Project)}
    for release in releases:
        project = projects.get(release.increment_code)
        release.project_id = project.id if project else None
        release.scope_narrative = (project.scope_narrative or None) if project else None
    return releases


def _list(db: Session) -> list[models.Release]:
    _add_missing_project_releases(db)
    _fill_missing_ptih_codes(db)
    _sync_project_dates(db)
    releases = db.query(models.Release).order_by(models.Release.sort_order, models.Release.id).all()
    return _mark_project_releases(db, releases)


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


@router.post("/reorder", status_code=204)
def reorder_releases(payload: schemas.ReleaseOrder, db: Session = Depends(get_db)):
    """Ordine delle release (dall'alto verso il basso): e' anche l'ordine in
    cui i PN si susseguono (vedi increment_components._next_pn)."""
    for position, release_id in enumerate(payload.release_ids, start=1):
        release = db.get(models.Release, release_id)
        if release is not None:
            release.sort_order = position
    db.commit()


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
    linked = db.query(models.Project).filter(models.Project.code == release.increment_code).count() > 0
    for field, value in payload.model_dump(exclude_unset=True).items():
        if linked and field in PROJECT_DATE_FIELDS:
            continue  # le date di un increment dell'app si cambiano nell'increment
        setattr(release, field, value)
    db.commit()
    db.refresh(release)
    return _mark_project_releases(db, [release])[0]


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
