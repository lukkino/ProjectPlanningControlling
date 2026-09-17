from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.metrics import compute_increment_metrics

router = APIRouter(prefix="/api/increments", tags=["increments"])

# Voci di default del budget ore per ruolo di un nuovo progetto, create
# automaticamente alla creazione (come STANDARD_PHASE_NAMES per i Project):
# restano comunque modificabili/rinominabili/eliminabili come le altre.
DEFAULT_BUDGET_ROLES = ["Project management", "Development", "Testing", "System Testing"]


def _get_increment_or_404(db: Session, increment_id: int) -> models.Increment:
    increment = db.get(models.Increment, increment_id)
    if increment is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return increment


def _get_budget_line_or_404(db: Session, line_id: int) -> models.IncrementBudgetLine:
    line = db.get(models.IncrementBudgetLine, line_id)
    if line is None:
        raise HTTPException(status_code=404, detail="Riga di budget non trovata")
    return line


@router.get("", response_model=list[schemas.Increment])
def list_increments(db: Session = Depends(get_db)):
    return db.query(models.Increment).order_by(models.Increment.code).all()


@router.post("", response_model=schemas.Increment, status_code=201)
def create_increment(payload: schemas.IncrementCreate, db: Session = Depends(get_db)):
    increment = models.Increment(**payload.model_dump())
    db.add(increment)
    db.flush()  # assegna increment.id, serve per le righe di budget sotto
    for order, role_name in enumerate(DEFAULT_BUDGET_ROLES, start=1):
        db.add(models.IncrementBudgetLine(increment_id=increment.id, role_name=role_name, order=order))
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
    # Scollega gli increment invece di lasciarli orfani/cancellarli: il
    # progetto e' solo un raggruppamento, gli Increment (con la loro
    # rendicontazione) restano validi anche senza un progetto.
    for project in increment.projects:
        project.increment_id = None
    db.delete(increment)
    db.commit()


# ---------- Budget lines ----------

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
    _get_increment_or_404(db, increment_id)
    line = models.IncrementBudgetLine(increment_id=increment_id, **payload.model_dump())
    db.add(line)
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
