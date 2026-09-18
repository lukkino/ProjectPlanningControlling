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
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(increment, field, value)
    db.commit()
    db.refresh(increment)
    return increment


@router.delete("/{increment_id}", status_code=204)
def delete_increment(increment_id: int, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    db.delete(increment)
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
    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(value, field, val)
    db.commit()
    db.refresh(value)
    return value
