"""Tab "Components & PN" di un increment: i componenti impattati e il loro
Part Number. Sono i componenti della release dell'increment nella sezione
Releases (stesso increment_code): si gestiscono qui, la sezione Releases li
mostra.

Il PN ha la forma <famiglia>.<numero> (es. PTB-SRV.020). Aggiungendo un
componente si propone il numero successivo al piu' alto della sua famiglia
tra le release chiuse della sezione Releases (Actual Release valorizzata).

Il menu dei componenti unisce i nomi presenti nella sezione Releases (la
famiglia e' quella del PN piu' recente del componente) e quelli creati a mano
qui (models.ComponentCatalogEntry), che vincono in caso di nome uguale.
"""

import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.routers.releases import _add_missing_project_releases, sync_release_from_project

router = APIRouter(prefix="/api", tags=["increment-components"])

PN_PATTERN = re.compile(r"^(?P<family>.+)\.(?P<number>\d+)$")


def _split_pn(pn: str | None) -> tuple[str, int, int] | None:
    """(famiglia, numero, cifre) del PN, None se non ha la forma attesa."""
    match = PN_PATTERN.match((pn or "").strip())
    if not match:
        return None
    return match["family"], int(match["number"]), len(match["number"])


def _release_rows(db: Session) -> list[tuple[models.Release, models.ReleaseComponent]]:
    return (
        db.query(models.Release, models.ReleaseComponent)
        .join(models.ReleaseComponent, models.ReleaseComponent.release_id == models.Release.id)
        .order_by(models.Release.sort_order, models.Release.id, models.ReleaseComponent.sort_order)
        .all()
    )


def _catalog(db: Session) -> dict[str, str | None]:
    """Nome componente -> famiglia del PN (None se sconosciuta)."""
    catalog: dict[str, str | None] = {}
    # Le release sono in ordine cronologico: vince il PN piu' recente.
    for _release, component in _release_rows(db):
        name = (component.component or "").strip()
        if not name:
            continue
        parts = _split_pn(component.pn)
        if parts or name not in catalog:
            catalog[name] = parts[0] if parts else catalog.get(name)
    for entry in db.query(models.ComponentCatalogEntry):
        catalog[entry.name] = entry.pn_family
    return catalog


def _next_pn(db: Session, family: str | None) -> str | None:
    """Il PN successivo al piu' alto della famiglia tra le release chiuse."""
    if not family:
        return None
    best: tuple[int, int] | None = None
    for release, component in _release_rows(db):
        parts = _split_pn(component.pn)
        if release.actual_release_date and parts and parts[0] == family:
            if best is None or parts[1] > best[0]:
                best = (parts[1], parts[2])
    if best is None:
        return None
    number, digits = best
    return f"{family}.{number + 1:0{digits}d}"


def _pn_usages(db: Session, project: models.Project) -> dict[str, set[str]]:
    """PN -> altri increment della sezione Releases che lo usano gia'."""
    usages: dict[str, set[str]] = {}
    for release, component in _release_rows(db):
        if component.pn and release.increment_code != project.code:
            usages.setdefault(component.pn.strip(), set()).add(release.increment_code or "release senza codice")
    return usages


def _read(component: models.ReleaseComponent, usages: dict[str, set[str]]) -> schemas.IncrementComponentRead:
    return schemas.IncrementComponentRead(
        id=component.id,
        name=component.component or "",
        pn=component.pn,
        fix_version=component.fix_version,
        detail=component.detail,
        note=component.note,
        pn_used_by=sorted(usages.get((component.pn or "").strip(), set())),
    )


def _project_release(db: Session, project: models.Project) -> models.Release | None:
    _add_missing_project_releases(db)
    return (
        db.query(models.Release)
        .filter(models.Release.increment_code == project.code)
        .order_by(models.Release.sort_order, models.Release.id)
        .first()
    )


def _get_project_or_404(db: Session, project_id: int) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Increment non trovato")
    return project


def _get_component_or_404(db: Session, component_id: int) -> models.ReleaseComponent:
    component = db.get(models.ReleaseComponent, component_id)
    if component is None:
        raise HTTPException(status_code=404, detail="Componente non trovato")
    return component


@router.get("/component-catalog", response_model=list[schemas.ComponentCatalogItem])
def list_catalog(db: Session = Depends(get_db)):
    catalog = _catalog(db)
    return [
        schemas.ComponentCatalogItem(name=name, pn_family=family, next_pn=_next_pn(db, family))
        for name, family in sorted(catalog.items(), key=lambda item: item[0].lower())
    ]


@router.post("/component-catalog", response_model=schemas.ComponentCatalogItem, status_code=201)
def create_catalog_entry(payload: schemas.ComponentCatalogWrite, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Il nome del componente e' obbligatorio")
    if any(existing.lower() == name.lower() for existing in _catalog(db)):
        raise HTTPException(status_code=409, detail=f"Il componente {name} esiste gia'")
    family = (payload.pn_family or "").strip() or None
    db.add(models.ComponentCatalogEntry(name=name, pn_family=family))
    db.commit()
    return schemas.ComponentCatalogItem(name=name, pn_family=family, next_pn=_next_pn(db, family))


@router.get("/projects/{project_id}/components", response_model=list[schemas.IncrementComponentRead])
def list_components(project_id: int, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    release = _project_release(db, project)
    if release is None:
        return []
    usages = _pn_usages(db, project)
    return [_read(component, usages) for component in release.components]


@router.post("/projects/{project_id}/components", response_model=schemas.IncrementComponentRead, status_code=201)
def create_component(project_id: int, payload: schemas.IncrementComponentCreate, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Scegli un componente")
    release = _project_release(db, project)
    if release is None:
        # Non dovrebbe capitare (la si crea per ogni increment), ma per
        # sicurezza: release nuova col codice dell'increment.
        last = db.query(func.max(models.Release.sort_order)).scalar() or 0
        release = models.Release(increment_code=project.code, sort_order=last + 1)
        db.add(release)
        db.flush()
    # Compilando i componenti si aggiornano anche i dati della release.
    sync_release_from_project(release, project)
    family = _catalog(db).get(name)
    pn = _next_pn(db, family)
    # Subito dopo l'ultimo componente della stessa famiglia, cosi' nella
    # sezione Releases i PN uguali restano vicini (e si uniscono); se la
    # famiglia non c'e' ancora, in fondo.
    siblings = sorted(release.components, key=lambda c: (c.sort_order, c.id))
    same_family = [c for c in siblings if family and (_split_pn(c.pn) or ("",))[0] == family]
    position = (same_family[-1].sort_order if same_family else max((c.sort_order for c in siblings), default=0)) + 1
    for sibling in siblings:
        if sibling.sort_order >= position:
            sibling.sort_order += 1
    component = models.ReleaseComponent(release_id=release.id, component=name, pn=pn, sort_order=position)
    db.add(component)
    db.commit()
    db.refresh(component)
    return _read(component, _pn_usages(db, project))


@router.put("/increment-components/{component_id}", response_model=schemas.IncrementComponentRead)
def update_component(component_id: int, payload: schemas.IncrementComponentUpdate, db: Session = Depends(get_db)):
    component = _get_component_or_404(db, component_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(component, field, (value.strip() or None) if isinstance(value, str) else value)
    db.commit()
    db.refresh(component)
    code = db.get(models.Release, component.release_id).increment_code
    project = db.query(models.Project).filter(models.Project.code == code).first()
    usages = _pn_usages(db, project) if project else {}
    return _read(component, usages)


@router.delete("/increment-components/{component_id}", status_code=204)
def delete_component(component_id: int, db: Session = Depends(get_db)):
    db.delete(_get_component_or_404(db, component_id))
    db.commit()


@router.get("/projects/{project_id}/release", response_model=schemas.ReleaseRead | None)
def get_project_release(project_id: int, db: Session = Depends(get_db)):
    """La riga dell'increment nella sezione Releases."""
    return _project_release(db, _get_project_or_404(db, project_id))


@router.post("/projects/{project_id}/release/sync", response_model=schemas.ReleaseRead)
def sync_project_release(project_id: int, db: Session = Depends(get_db)):
    """Aggiorna la riga dell'increment nella sezione Releases coi suoi dati."""
    project = _get_project_or_404(db, project_id)
    release = _project_release(db, project)
    if release is None:
        raise HTTPException(status_code=404, detail="Release dell'increment non trovata")
    sync_release_from_project(release, project)
    db.commit()
    db.refresh(release)
    return release
