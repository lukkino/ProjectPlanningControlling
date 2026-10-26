from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.metrics import compute_increment_metrics

router = APIRouter(prefix="/api/increments", tags=["increments"])

# Voci di default dello Storico progetto di un nuovo progetto, create
# automaticamente alla creazione (come STANDARD_PHASE_NAMES per i Project):
# restano comunque modificabili/rinominabili/eliminabili come le altre.
# Solo "Hours" e' in ore (is_hours=True): le altre sono voci di spesa.
DEFAULT_BUDGET_CATEGORIES = [
    ("Hours", True),
    ("Prototype", False),
    ("Preserie", False),
    ("Consultancies", False),
    ("Travels", False),
]


def _get_increment_or_404(db: Session, increment_id: int) -> models.Increment:
    increment = db.get(models.Increment, increment_id)
    if increment is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return increment


def _get_budget_line_or_404(db: Session, line_id: int) -> models.IncrementBudgetLine:
    line = db.get(models.IncrementBudgetLine, line_id)
    if line is None:
        raise HTTPException(status_code=404, detail="Voce di budget non trovata")
    return line


def _get_snapshot_or_404(db: Session, snapshot_id: int) -> models.IncrementSnapshot:
    snapshot = db.get(models.IncrementSnapshot, snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Snapshot non trovato")
    return snapshot


def _get_snapshot_value_or_404(db: Session, value_id: int) -> models.IncrementSnapshotValue:
    value = db.get(models.IncrementSnapshotValue, value_id)
    if value is None:
        raise HTTPException(status_code=404, detail="Valore snapshot non trovato")
    return value


def _get_resource_type_or_404(db: Session, resource_type_id: int) -> models.IncrementResourceType:
    resource_type = db.get(models.IncrementResourceType, resource_type_id)
    if resource_type is None:
        raise HTTPException(status_code=404, detail="Tipologia di risorsa non trovata")
    return resource_type


def _hours_calculator(increment: models.Increment) -> schemas.HoursCalculator:
    return schemas.HoursCalculator(
        start_date=increment.calc_start_date,
        end_date=increment.calc_end_date,
        vacation_days=increment.calc_vacation_days or 0,
        resource_types=list(increment.resource_types),
    )


@router.get("", response_model=list[schemas.Increment])
def list_increments(db: Session = Depends(get_db)):
    return db.query(models.Increment).order_by(models.Increment.code).all()


@router.post("", response_model=schemas.Increment, status_code=201)
def create_increment(payload: schemas.IncrementCreate, db: Session = Depends(get_db)):
    increment = models.Increment(**payload.model_dump())
    db.add(increment)
    db.flush()  # assegna increment.id, serve per le voci di budget sotto
    for order, (category_name, is_hours) in enumerate(DEFAULT_BUDGET_CATEGORIES, start=1):
        db.add(
            models.IncrementBudgetLine(
                increment_id=increment.id, category_name=category_name, is_hours=is_hours, order=order
            )
        )
    for order, name in enumerate(models.DEFAULT_RESOURCE_TYPES, start=1):
        db.add(models.IncrementResourceType(increment_id=increment.id, name=name, order=order))
    db.commit()
    db.refresh(increment)
    return increment


@router.get("/{increment_id}", response_model=schemas.IncrementDetail)
def get_increment(increment_id: int, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    return compute_increment_metrics(increment)


@router.put("/{increment_id}", response_model=schemas.Increment)
def update_increment(increment_id: int, payload: schemas.IncrementUpdate, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    data = payload.model_dump(exclude_unset=True)
    # Un progetto si collega per intero oppure tramite i sotto-progetti.
    if data.get("project_id") is not None and any(s.project_id is not None for s in increment.sub_projects):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Il progetto {increment.code} ha sotto-progetti già collegati a un increment: "
                "scollegali prima di collegare il progetto intero."
            ),
        )
    for field, value in data.items():
        setattr(increment, field, value)
    db.commit()
    db.refresh(increment)
    return increment


@router.delete("/{increment_id}", status_code=204)
def delete_increment(increment_id: int, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    db.delete(increment)
    db.commit()


# ---------- Sotto-progetti ----------

def _get_sub_project_or_404(db: Session, sub_project_id: int) -> models.SubProject:
    sub_project = db.get(models.SubProject, sub_project_id)
    if sub_project is None:
        raise HTTPException(status_code=404, detail="Sotto-progetto non trovato")
    return sub_project


@router.post("/{increment_id}/sub-projects", response_model=schemas.SubProject, status_code=201)
def create_sub_project(increment_id: int, payload: schemas.SubProjectCreate, db: Session = Depends(get_db)):
    _get_increment_or_404(db, increment_id)
    sub_project = models.SubProject(increment_id=increment_id, **payload.model_dump())
    db.add(sub_project)
    db.commit()
    db.refresh(sub_project)
    return sub_project


@router.put("/sub-projects/{sub_project_id}", response_model=schemas.SubProject)
def update_sub_project(sub_project_id: int, payload: schemas.SubProjectUpdate, db: Session = Depends(get_db)):
    sub_project = _get_sub_project_or_404(db, sub_project_id)
    data = payload.model_dump(exclude_unset=True)
    if data.get("project_id") is not None:
        if db.get(models.Project, data["project_id"]) is None:
            raise HTTPException(status_code=404, detail="Increment non trovato")
        # Un progetto si collega per intero oppure tramite i sotto-progetti.
        if sub_project.increment.project_id is not None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Il progetto {sub_project.increment.code} è già collegato per intero a un increment: "
                    "scollegalo prima di collegare un suo sotto-progetto."
                ),
            )
    for field, value in data.items():
        # Nome e budget non sono annullabili: un valore vuoto non li cambia.
        if value is None and field != "project_id":
            continue
        setattr(sub_project, field, value)
    db.commit()
    db.refresh(sub_project)
    return sub_project


@router.delete("/sub-projects/{sub_project_id}", status_code=204)
def delete_sub_project(sub_project_id: int, db: Session = Depends(get_db)):
    sub_project = _get_sub_project_or_404(db, sub_project_id)
    db.delete(sub_project)
    db.commit()


# ---------- Budget lines (voci dello Storico progetto) ----------

@router.get("/{increment_id}/budget-lines", response_model=list[schemas.IncrementBudgetLine])
def list_budget_lines(increment_id: int, db: Session = Depends(get_db)):
    _get_increment_or_404(db, increment_id)
    return (
        db.query(models.IncrementBudgetLine)
        .filter(models.IncrementBudgetLine.increment_id == increment_id)
        .order_by(models.IncrementBudgetLine.order)
        .all()
    )


@router.post("/{increment_id}/budget-lines", response_model=schemas.IncrementBudgetLine, status_code=201)
def create_budget_line(increment_id: int, payload: schemas.IncrementBudgetLineCreate, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    line = models.IncrementBudgetLine(increment_id=increment_id, **payload.model_dump())
    db.add(line)
    db.flush()
    # Ogni snapshot esistente riceve un valore (0/0) per la nuova voce, cosi'
    # la tabella dello Storico resta un rettangolo pieno senza celle
    # mancanti per gli snapshot presi prima di questa voce.
    for snapshot in increment.snapshots:
        db.add(
            models.IncrementSnapshotValue(
                snapshot_id=snapshot.id, budget_line_id=line.id, budget_value=0, actual_value=0
            )
        )
    db.commit()
    db.refresh(line)
    return line


@router.put("/budget-lines/{line_id}", response_model=schemas.IncrementBudgetLine)
def update_budget_line(line_id: int, payload: schemas.IncrementBudgetLineUpdate, db: Session = Depends(get_db)):
    line = _get_budget_line_or_404(db, line_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(line, field, value)
    db.commit()
    db.refresh(line)
    return line


@router.delete("/budget-lines/{line_id}", status_code=204)
def delete_budget_line(line_id: int, db: Session = Depends(get_db)):
    line = _get_budget_line_or_404(db, line_id)
    db.delete(line)
    db.commit()


# ---------- Storico progetto (snapshot periodici su Budget/Actual) ----------

@router.get("/{increment_id}/snapshots", response_model=list[schemas.IncrementSnapshot])
def list_snapshots(increment_id: int, db: Session = Depends(get_db)):
    _get_increment_or_404(db, increment_id)
    return (
        db.query(models.IncrementSnapshot)
        .filter(models.IncrementSnapshot.increment_id == increment_id)
        .order_by(models.IncrementSnapshot.snapshot_date)
        .all()
    )


@router.post("/{increment_id}/snapshots", response_model=schemas.IncrementSnapshot, status_code=201)
def create_snapshot(increment_id: int, payload: schemas.IncrementSnapshotCreate, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    snapshot = models.IncrementSnapshot(increment_id=increment_id, **payload.model_dump())
    db.add(snapshot)
    db.flush()

    # Budget e Actual sono entrambi cumulativi: ogni nuova voce riparte dai
    # valori dell'ultimo snapshot esistente (0 se e' il primo, o per una
    # voce aggiunta dopo di esso). Il budget di solito resta invariato da
    # uno snapshot all'altro (salvo una revisione budget) - riparte comunque
    # dall'ultimo valore invece che da zero, cosi' non va reinserito ad ogni
    # snapshot.
    previous = (
        db.query(models.IncrementSnapshot)
        .filter(models.IncrementSnapshot.increment_id == increment_id, models.IncrementSnapshot.id != snapshot.id)
        .order_by(models.IncrementSnapshot.snapshot_date.desc())
        .first()
    )
    previous_by_line = {v.budget_line_id: v for v in previous.values} if previous else {}
    for line in increment.budget_lines:
        prev_value = previous_by_line.get(line.id)
        db.add(
            models.IncrementSnapshotValue(
                snapshot_id=snapshot.id,
                budget_line_id=line.id,
                budget_value=prev_value.budget_value if prev_value else 0,
                actual_value=prev_value.actual_value if prev_value else 0,
                # Anche la ripartizione dell'Actual riparte dal precedente.
                entries=[
                    models.IncrementSnapshotValueEntry(name=e.name, hours=e.hours)
                    for e in (prev_value.entries if prev_value else [])
                ],
            )
        )
    # Lo stesso per l'Actual ore dei sotto-progetti, cumulativo anche lui.
    for prev_sub_value in previous.sub_values if previous else []:
        db.add(
            models.IncrementSnapshotSubValue(
                snapshot_id=snapshot.id,
                sub_project_id=prev_sub_value.sub_project_id,
                actual_hours=prev_sub_value.actual_hours,
            )
        )

    db.commit()
    db.refresh(snapshot)
    return snapshot


@router.put("/snapshots/{snapshot_id}", response_model=schemas.IncrementSnapshot)
def update_snapshot(snapshot_id: int, payload: schemas.IncrementSnapshotUpdate, db: Session = Depends(get_db)):
    snapshot = _get_snapshot_or_404(db, snapshot_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(snapshot, field, value)
    db.commit()
    db.refresh(snapshot)
    return snapshot


@router.delete("/snapshots/{snapshot_id}", status_code=204)
def delete_snapshot(snapshot_id: int, db: Session = Depends(get_db)):
    snapshot = _get_snapshot_or_404(db, snapshot_id)
    db.delete(snapshot)
    db.commit()


@router.put("/snapshot-values/{value_id}", response_model=schemas.IncrementSnapshotValue)
def update_snapshot_value(value_id: int, payload: schemas.IncrementSnapshotValueUpdate, db: Session = Depends(get_db)):
    value = _get_snapshot_value_or_404(db, value_id)
    data = payload.model_dump(exclude_unset=True)
    # Con la ripartizione l'Actual e' la somma delle sue voci.
    if value.entries:
        data.pop("actual_value", None)
    for field, val in data.items():
        setattr(value, field, val)
    db.commit()
    db.refresh(value)
    return value


# ---------- Ripartizione dell'Actual ore di uno snapshot ----------

# Voci in cui si ripartisce l'Actual di una voce in ore.
# Gli stessi ruoli del Calcolatore e del Dettaglio budget ore.
ACTUAL_SPLIT_NAMES = models.DEFAULT_RESOURCE_TYPES


def _get_value_entry_or_404(db: Session, entry_id: int) -> models.IncrementSnapshotValueEntry:
    entry = db.get(models.IncrementSnapshotValueEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Riga del dettaglio non trovata")
    return entry


def _save_entries(db: Session, value: models.IncrementSnapshotValue) -> models.IncrementSnapshotValue:
    db.flush()
    db.refresh(value)
    value.actual_value = round(sum(e.hours for e in value.entries), 2)
    db.commit()
    db.refresh(value)
    return value


@router.post("/snapshot-values/{value_id}/split", response_model=schemas.IncrementSnapshotValue, status_code=201)
def create_value_split(value_id: int, db: Session = Depends(get_db)):
    """Ripartisce l'Actual di una voce in ore nelle voci ACTUAL_SPLIT_NAMES,
    tutte a 0: da qui in poi l'Actual e' la loro somma."""
    value = _get_snapshot_value_or_404(db, value_id)
    if not value.budget_line.is_hours:
        raise HTTPException(status_code=400, detail="La ripartizione vale solo per le voci in ore")
    if value.entries:
        raise HTTPException(status_code=400, detail="L'Actual di questa voce è già ripartito")
    for name in ACTUAL_SPLIT_NAMES:
        db.add(models.IncrementSnapshotValueEntry(value_id=value.id, name=name, hours=0))
    return _save_entries(db, value)


@router.put("/snapshot-value-entries/{entry_id}", response_model=schemas.IncrementSnapshotValue)
def update_value_entry(
    entry_id: int, payload: schemas.IncrementSnapshotValueEntryUpdate, db: Session = Depends(get_db)
):
    entry = _get_value_entry_or_404(db, entry_id)
    entry.hours = payload.hours
    return _save_entries(db, entry.value)


@router.delete("/snapshot-values/{value_id}/split", response_model=schemas.IncrementSnapshotValue)
def delete_value_split(value_id: int, db: Session = Depends(get_db)):
    """Toglie la ripartizione: l'Actual resta all'ultimo totale e torna
    modificabile a mano."""
    value = _get_snapshot_value_or_404(db, value_id)
    value.entries.clear()
    db.commit()
    db.refresh(value)
    return value


@router.put(
    "/snapshots/{snapshot_id}/sub-projects/{sub_project_id}", response_model=schemas.IncrementSnapshotSubValue
)
def set_snapshot_sub_project_hours(
    snapshot_id: int,
    sub_project_id: int,
    payload: schemas.IncrementSnapshotSubValueUpdate,
    db: Session = Depends(get_db),
):
    """Actual ore di un sotto-progetto in uno snapshot: crea il valore se
    non c'e' ancora (le righe nascono solo quando servono)."""
    snapshot = _get_snapshot_or_404(db, snapshot_id)
    sub_project = _get_sub_project_or_404(db, sub_project_id)
    if sub_project.increment_id != snapshot.increment_id:
        raise HTTPException(status_code=400, detail="Il sotto-progetto non appartiene al progetto di questo snapshot")
    value = next((v for v in snapshot.sub_values if v.sub_project_id == sub_project_id), None)
    if value is None:
        value = models.IncrementSnapshotSubValue(snapshot_id=snapshot_id, sub_project_id=sub_project_id)
        db.add(value)
    value.actual_hours = payload.actual_hours
    db.commit()
    db.refresh(value)
    return value


# ---------- Calcolatore ore progetto ----------

@router.get("/{increment_id}/hours-calculator", response_model=schemas.HoursCalculator)
def get_hours_calculator(increment_id: int, db: Session = Depends(get_db)):
    return _hours_calculator(_get_increment_or_404(db, increment_id))


@router.put("/{increment_id}/hours-calculator", response_model=schemas.HoursCalculator)
def update_hours_calculator(increment_id: int, payload: schemas.HoursCalculatorUpdate, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        # vacation_days non e' annullabile: un valore vuoto vale 0.
        setattr(increment, f"calc_{field}", (value or 0) if field == "vacation_days" else value)
    db.commit()
    db.refresh(increment)
    return _hours_calculator(increment)


@router.post("/{increment_id}/resource-types", response_model=schemas.IncrementResourceType, status_code=201)
def create_resource_type(
    increment_id: int, payload: schemas.IncrementResourceTypeCreate, db: Session = Depends(get_db)
):
    _get_increment_or_404(db, increment_id)
    resource_type = models.IncrementResourceType(increment_id=increment_id, **payload.model_dump())
    db.add(resource_type)
    db.commit()
    db.refresh(resource_type)
    return resource_type


@router.put("/resource-types/{resource_type_id}", response_model=schemas.IncrementResourceType)
def update_resource_type(
    resource_type_id: int, payload: schemas.IncrementResourceTypeUpdate, db: Session = Depends(get_db)
):
    resource_type = _get_resource_type_or_404(db, resource_type_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(resource_type, field, value)
    db.commit()
    db.refresh(resource_type)
    return resource_type


@router.delete("/resource-types/{resource_type_id}", status_code=204)
def delete_resource_type(resource_type_id: int, db: Session = Depends(get_db)):
    resource_type = _get_resource_type_or_404(db, resource_type_id)
    db.delete(resource_type)
    db.commit()


def _get_member_or_404(db: Session, member_id: int) -> models.IncrementTeamMember:
    member = db.get(models.IncrementTeamMember, member_id)
    if member is None:
        raise HTTPException(status_code=404, detail="Persona non trovata")
    return member


@router.post(
    "/resource-types/{resource_type_id}/members", response_model=schemas.TeamMember, status_code=201
)
def create_team_member(resource_type_id: int, payload: schemas.TeamMemberCreate, db: Session = Depends(get_db)):
    resource_type = _get_resource_type_or_404(db, resource_type_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Il nome della persona è obbligatorio")
    member = models.IncrementTeamMember(
        resource_type_id=resource_type.id,
        name=name,
        hours_per_day=resource_type.hours_per_day if payload.hours_per_day is None else payload.hours_per_day,
        order=max((m.order for m in resource_type.members), default=0) + 1,
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


@router.put("/members/{member_id}", response_model=schemas.TeamMember)
def update_team_member(member_id: int, payload: schemas.TeamMemberUpdate, db: Session = Depends(get_db)):
    member = _get_member_or_404(db, member_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if field == "name":
            value = (value or "").strip()
            if not value:
                raise HTTPException(status_code=400, detail="Il nome della persona è obbligatorio")
        setattr(member, field, value)
    db.commit()
    db.refresh(member)
    return member


@router.delete("/members/{member_id}", status_code=204)
def delete_team_member(member_id: int, db: Session = Depends(get_db)):
    db.delete(_get_member_or_404(db, member_id))
    db.commit()


@router.post("/members/{member_id}/absences", response_model=schemas.MemberAbsence, status_code=201)
def create_member_absence(member_id: int, payload: schemas.MemberAbsenceCreate, db: Session = Depends(get_db)):
    _get_member_or_404(db, member_id)
    absence = models.IncrementMemberAbsence(
        member_id=member_id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        kind=payload.kind,
        note=(payload.note or "").strip() or None,
    )
    db.add(absence)
    db.commit()
    db.refresh(absence)
    return absence


@router.delete("/absences/{absence_id}", status_code=204)
def delete_member_absence(absence_id: int, db: Session = Depends(get_db)):
    absence = db.get(models.IncrementMemberAbsence, absence_id)
    if absence is None:
        raise HTTPException(status_code=404, detail="Ferie non trovate")
    db.delete(absence)
    db.commit()


# ---------- Dettaglio budget ore progetto ----------

def _hours_detail(increment: models.Increment) -> schemas.HoursDetail:
    return schemas.HoursDetail(
        rows=[
            schemas.HoursDetailRow(
                id=row.id,
                name=row.name,
                resource_count=row.resource_count,
                hours=row.hours,
                review_hours={value.review_id: value.hours for value in row.review_values},
            )
            for row in increment.hours_detail_rows
        ],
        reviews=list(increment.hours_reviews),
    )


def _get_hours_review_or_404(db: Session, review_id: int) -> models.IncrementHoursReview:
    review = db.get(models.IncrementHoursReview, review_id)
    if review is None:
        raise HTTPException(status_code=404, detail="Revisione non trovata")
    return review


@router.get("/{increment_id}/hours-detail", response_model=schemas.HoursDetail)
def get_hours_detail(increment_id: int, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    # Prima lettura: le colonne di revisione di partenza.
    if not increment.hours_reviews:
        for order, name in enumerate(models.DEFAULT_HOURS_REVIEWS, start=1):
            increment.hours_reviews.append(models.IncrementHoursReview(name=name, order=order))
        db.commit()
        db.refresh(increment)
    return _hours_detail(increment)


@router.put("/{increment_id}/hours-detail/rows", response_model=schemas.HoursDetail)
def update_hours_detail_rows(
    increment_id: int, payload: list[schemas.HoursDetailRowInput], db: Session = Depends(get_db)
):
    """"Aggiorna ore progetto": le righe diventano le tipologie del
    calcolatore. Le righe gia' presenti con lo stesso nome vengono
    aggiornate e tengono le ore delle revisioni; quelle che non ci sono piu'
    vengono eliminate."""
    increment = _get_increment_or_404(db, increment_id)
    existing = {row.name.strip().lower(): row for row in increment.hours_detail_rows}
    for order, item in enumerate(payload, start=1):
        row = existing.pop(item.name.strip().lower(), None)
        if row is None:
            row = models.IncrementHoursDetailRow(increment_id=increment.id)
            db.add(row)
        row.name = item.name.strip()
        row.resource_count = item.resource_count
        row.hours = item.hours
        row.order = order
    for row in existing.values():
        db.delete(row)
    db.commit()
    db.refresh(increment)
    return _hours_detail(increment)


@router.put("/hours-detail/rows/{row_id}", response_model=schemas.HoursDetail)
def update_hours_detail_row(row_id: int, payload: schemas.HoursDetailRowUpdate, db: Session = Depends(get_db)):
    """Ore di una riga corrette a mano (es. arrotondate): restano finche' un
    nuovo "Aggiorna ore progetto" non le sovrascrive."""
    row = db.get(models.IncrementHoursDetailRow, row_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Riga del dettaglio ore non trovata")
    row.hours = payload.hours
    db.commit()
    db.refresh(row.increment)
    return _hours_detail(row.increment)


@router.post("/{increment_id}/hours-detail/reviews", response_model=schemas.HoursDetail, status_code=201)
def create_hours_review(increment_id: int, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    order = max((r.order for r in increment.hours_reviews), default=0) + 1
    increment.hours_reviews.append(
        models.IncrementHoursReview(name=f"Review {len(increment.hours_reviews) + 1}", order=order)
    )
    db.commit()
    db.refresh(increment)
    return _hours_detail(increment)


@router.put("/hours-detail/reviews/{review_id}", response_model=schemas.HoursDetail)
def update_hours_review(review_id: int, payload: schemas.HoursReviewUpdate, db: Session = Depends(get_db)):
    review = _get_hours_review_or_404(db, review_id)
    review.name = payload.name.strip() or review.name
    db.commit()
    db.refresh(review.increment)
    return _hours_detail(review.increment)


@router.delete("/hours-detail/reviews/{review_id}", response_model=schemas.HoursDetail)
def delete_hours_review(review_id: int, db: Session = Depends(get_db)):
    review = _get_hours_review_or_404(db, review_id)
    increment = review.increment
    db.delete(review)
    db.commit()
    db.refresh(increment)
    return _hours_detail(increment)


@router.put("/hours-detail/reviews/{review_id}/rows/{row_id}", response_model=schemas.HoursDetail)
def set_hours_review_value(
    review_id: int, row_id: int, payload: schemas.HoursReviewValueUpdate, db: Session = Depends(get_db)
):
    review = _get_hours_review_or_404(db, review_id)
    row = db.get(models.IncrementHoursDetailRow, row_id)
    if row is None or row.increment_id != review.increment_id:
        raise HTTPException(status_code=404, detail="Riga del dettaglio ore non trovata")
    value = next((v for v in review.values if v.row_id == row_id), None)
    if payload.hours is None:
        if value is not None:
            db.delete(value)
    elif value is None:
        db.add(models.IncrementHoursReviewValue(review_id=review.id, row_id=row.id, hours=payload.hours))
    else:
        value.hours = payload.hours
    db.commit()
    db.refresh(review.increment)
    return _hours_detail(review.increment)
