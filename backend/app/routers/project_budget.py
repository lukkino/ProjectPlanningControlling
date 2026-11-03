"""Budget di un progetto (UI "Progetto" = models.Increment): Dettaglio
budget ore, Budget materiali (bozza) e Dettaglio materiali, congelamento,
review di budget ed export del file di budget. Il modello e' descritto in
services/budget.py."""

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services import budget
from app.services.budget_export import BudgetExportError, generate_budget_file

router = APIRouter(prefix="/api/increments", tags=["project-budget"])


def _get_increment_or_404(db: Session, increment_id: int) -> models.Increment:
    increment = db.get(models.Increment, increment_id)
    if increment is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return increment


def _check_not_frozen(increment: models.Increment, correction: bool = False) -> None:
    """Dopo il congelamento il budget iniziale cambia solo come correzione
    esplicita (correction=true: un errore, una risorsa dimenticata), che
    resta registrata; le variazioni vere vanno in una review di budget."""
    if increment.budget_frozen_at is None:
        return
    if not correction:
        raise HTTPException(
            status_code=409,
            detail="Il budget e' congelato: correggilo come correzione del budget iniziale o con una review di budget",
        )
    increment.budget_corrected_at = models._utcnow()


def _budget_changed(db: Session, increment: models.Increment) -> None:
    """Dopo una modifica del budget che vale: va anche nell'ultimo snapshot."""
    db.flush()
    db.refresh(increment)
    budget.sync_latest_snapshot(db, increment)
    db.commit()
    db.refresh(increment)


def _check_department(code: str | None) -> None:
    if code is not None and code not in budget.DEPARTMENT_CODES:
        raise HTTPException(status_code=400, detail=f"Reparto non valido: {code}")


def _check_material(category: str, section: str | None) -> None:
    if category not in budget.MATERIAL_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"Categoria non valida: {category}")
    if category in budget.CATEGORIES_WITHOUT_SECTIONS:
        if section:
            raise HTTPException(status_code=400, detail=f"{category} non ha sezioni")
    elif section not in budget.MATERIAL_SECTIONS:
        raise HTTPException(status_code=400, detail=f"Sezione non valida: {section}")


def _apply_material(item, data: dict) -> None:
    """Campi di una riga materiali (bozza o review) da un payload, con i
    controlli su categoria e sezione."""
    if "description" in data:
        description = (data["description"] or "").strip()
        if not description:
            raise HTTPException(status_code=400, detail="La descrizione e' obbligatoria")
        item.description = description
    for field in ("unit_cost", "units", "modules"):
        if field in data and data[field] is not None:
            setattr(item, field, data[field])
    if "category" in data and data["category"] is not None:
        item.category = data["category"]
        if item.category in budget.CATEGORIES_WITHOUT_SECTIONS:
            item.section = None
    if "section" in data:
        item.section = data["section"] or None
    if item.section is None and item.category not in budget.CATEGORIES_WITHOUT_SECTIONS:
        item.section = budget.MATERIAL_SECTIONS[0]
    _check_material(item.category, item.section)


def _new_material(model, data: dict, **keys):
    item = model(
        category=data.get("category") or budget.MATERIAL_CATEGORIES[1],
        section=None,
        description="",
        unit_cost=0,
        units=1,
        modules=1,
        **keys,
    )
    _apply_material(item, {"description": data.get("description"), **{k: v for k, v in data.items() if k != "description"}})
    return item


# ---------- Catalogo e stato ----------

@router.get("/budget-catalog", response_model=schemas.BudgetCatalog)
def get_budget_catalog():
    """Reparti, societa', categorie e sezioni del file di budget."""
    return schemas.BudgetCatalog(
        departments=[schemas.BudgetDepartment(code=c, name=n) for c, n in budget.DEPARTMENTS],
        companies=budget.COMPANIES,
        categories=budget.MATERIAL_CATEGORIES,
        sections=budget.MATERIAL_SECTIONS,
        categories_without_sections=sorted(budget.CATEGORIES_WITHOUT_SECTIONS),
    )


@router.post("/{increment_id}/budget/freeze", response_model=schemas.BudgetStatus)
def freeze_budget(increment_id: int, db: Session = Depends(get_db)):
    """"Congela budget": il budget iniziale (Dettaglio budget ore e Dettaglio
    materiali) non cambia piu'; da qui si va avanti con le review."""
    increment = _get_increment_or_404(db, increment_id)
    if increment.budget_frozen_at is None:
        increment.budget_frozen_at = models._utcnow()
        db.commit()
    return schemas.BudgetStatus(frozen_at=increment.budget_frozen_at)


@router.delete("/{increment_id}/budget/freeze", response_model=schemas.BudgetStatus)
def unfreeze_budget(increment_id: int, db: Session = Depends(get_db)):
    """Annulla il congelamento (per correggere il budget iniziale)."""
    increment = _get_increment_or_404(db, increment_id)
    increment.budget_frozen_at = None
    increment.budget_corrected_at = None
    db.commit()
    return schemas.BudgetStatus(frozen_at=None)


@router.get("/{increment_id}/budget/export")
def export_budget(increment_id: int, db: Session = Depends(get_db)):
    """File di budget del progetto dal template aziendale."""
    increment = _get_increment_or_404(db, increment_id)
    try:
        content, filename = generate_budget_file(increment)
    except BudgetExportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------- Dettaglio budget ore progetto ----------

def _hours_detail(increment: models.Increment) -> schemas.HoursDetail:
    return schemas.HoursDetail(
        rows=[schemas.HoursDetailRow.model_validate(row) for row in increment.hours_detail_rows],
        frozen_at=increment.budget_frozen_at,
    )


@router.get("/{increment_id}/hours-detail", response_model=schemas.HoursDetail)
def get_hours_detail(increment_id: int, db: Session = Depends(get_db)):
    return _hours_detail(_get_increment_or_404(db, increment_id))


@router.put("/{increment_id}/hours-detail/rows", response_model=schemas.HoursDetail)
def update_hours_detail_rows(
    increment_id: int,
    payload: list[schemas.HoursDetailRowInput],
    correction: bool = Query(False),
    db: Session = Depends(get_db),
):
    """"Aggiorna ore progetto": le righe diventano quelle del calcolatore,
    una per tipologia e societa' (le precedenti vengono sostituite)."""
    increment = _get_increment_or_404(db, increment_id)
    _check_not_frozen(increment, correction)
    for item in payload:
        _check_department(item.department)
    increment.hours_detail_rows.clear()
    db.flush()
    for order, item in enumerate(payload, start=1):
        increment.hours_detail_rows.append(
            models.IncrementHoursDetailRow(
                name=item.name.strip(),
                department=item.department,
                company=item.company,
                resource_count=item.resource_count,
                hours=item.hours,
                order=order,
            )
        )
    _budget_changed(db, increment)
    return _hours_detail(increment)


@router.put("/hours-detail/rows/{row_id}", response_model=schemas.HoursDetail)
def update_hours_detail_row(
    row_id: int,
    payload: schemas.HoursDetailRowUpdate,
    correction: bool = Query(False),
    db: Session = Depends(get_db),
):
    """Ore (es. arrotondate) o reparto di una riga corretti a mano: restano
    finche' un nuovo "Aggiorna ore progetto" non le sovrascrive."""
    row = db.get(models.IncrementHoursDetailRow, row_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Riga del dettaglio ore non trovata")
    _check_not_frozen(row.increment, correction)
    data = payload.model_dump(exclude_unset=True)
    if "department" in data:
        _check_department(data["department"])
    for field, value in data.items():
        setattr(row, field, value)
    increment = row.increment
    _budget_changed(db, increment)
    return _hours_detail(increment)


# ---------- Budget materiali (bozza) ----------

def _get_material_cost_or_404(db: Session, cost_id: int) -> models.IncrementMaterialCost:
    cost = db.get(models.IncrementMaterialCost, cost_id)
    if cost is None:
        raise HTTPException(status_code=404, detail="Voce materiali non trovata")
    return cost


@router.get("/{increment_id}/material-costs", response_model=list[schemas.MaterialCost])
def list_material_costs(increment_id: int, db: Session = Depends(get_db)):
    return _get_increment_or_404(db, increment_id).material_costs


@router.post("/{increment_id}/material-costs", response_model=schemas.MaterialCost, status_code=201)
def create_material_cost(increment_id: int, payload: schemas.MaterialWrite, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    last = max((c.order for c in increment.material_costs), default=0)
    cost = _new_material(
        models.IncrementMaterialCost, payload.model_dump(exclude_unset=True), increment_id=increment.id, order=last + 1
    )
    db.add(cost)
    db.commit()
    db.refresh(cost)
    return cost


@router.put("/material-costs/{cost_id}", response_model=schemas.MaterialCost)
def update_material_cost(cost_id: int, payload: schemas.MaterialWrite, db: Session = Depends(get_db)):
    cost = _get_material_cost_or_404(db, cost_id)
    _apply_material(cost, payload.model_dump(exclude_unset=True))
    db.commit()
    db.refresh(cost)
    return cost


@router.delete("/material-costs/{cost_id}", status_code=204)
def delete_material_cost(cost_id: int, db: Session = Depends(get_db)):
    db.delete(_get_material_cost_or_404(db, cost_id))
    db.commit()


# ---------- Dettaglio materiali progetto ----------

def _material_budget(increment: models.Increment) -> schemas.MaterialBudget:
    rows = increment.material_budget_rows
    return schemas.MaterialBudget(
        rows=[schemas.MaterialBudgetRow.model_validate(row) for row in rows],
        published_at=max((row.published_at for row in rows), default=None),
        frozen_at=increment.budget_frozen_at,
    )


@router.get("/{increment_id}/material-budget", response_model=schemas.MaterialBudget)
def get_material_budget(increment_id: int, db: Session = Depends(get_db)):
    return _material_budget(_get_increment_or_404(db, increment_id))


@router.put("/{increment_id}/material-budget", response_model=schemas.MaterialBudget)
def publish_material_budget(increment_id: int, correction: bool = Query(False), db: Session = Depends(get_db)):
    """"Aggiorna materiali progetto": le voci del Budget materiali di adesso
    diventano il Dettaglio materiali (sostituiscono le precedenti)."""
    increment = _get_increment_or_404(db, increment_id)
    _check_not_frozen(increment, correction)
    increment.material_budget_rows.clear()
    db.flush()
    now = models._utcnow()
    for order, cost in enumerate(increment.material_costs, start=1):
        increment.material_budget_rows.append(
            models.IncrementMaterialBudgetRow(
                category=cost.category,
                section=cost.section,
                description=cost.description,
                unit_cost=cost.unit_cost,
                units=cost.units,
                modules=cost.modules,
                order=order,
                published_at=now,
            )
        )
    _budget_changed(db, increment)
    return _material_budget(increment)


# ---------- Review di budget ----------

def _get_review_or_404(db: Session, review_id: int) -> models.IncrementBudgetReview:
    review = db.get(models.IncrementBudgetReview, review_id)
    if review is None:
        raise HTTPException(status_code=404, detail="Review di budget non trovata")
    return review


@router.get("/{increment_id}/budget-reviews", response_model=list[schemas.BudgetReview])
def list_budget_reviews(increment_id: int, db: Session = Depends(get_db)):
    return _get_increment_or_404(db, increment_id).budget_reviews


@router.post("/{increment_id}/budget-reviews", response_model=schemas.BudgetReview, status_code=201)
def create_budget_review(increment_id: int, payload: schemas.BudgetReviewWrite, db: Session = Depends(get_db)):
    increment = _get_increment_or_404(db, increment_id)
    if increment.budget_frozen_at is None:
        raise HTTPException(status_code=409, detail="Prima congela il budget: le review si aggiungono al budget congelato")
    order = max((r.order for r in increment.budget_reviews), default=0) + 1
    review = models.IncrementBudgetReview(
        name=(payload.name or "").strip() or f"Review {len(increment.budget_reviews) + 1}",
        review_date=payload.review_date or models._utcnow().date(),
        note=payload.note,
        order=order,
    )
    increment.budget_reviews.append(review)
    db.commit()
    db.refresh(review)
    return review


@router.put("/budget-reviews/{review_id}", response_model=schemas.BudgetReview)
def update_budget_review(review_id: int, payload: schemas.BudgetReviewWrite, db: Session = Depends(get_db)):
    review = _get_review_or_404(db, review_id)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        review.name = (data["name"] or "").strip() or review.name
    if "review_date" in data:
        review.review_date = data["review_date"]
    if "note" in data:
        review.note = data["note"]
    db.commit()
    db.refresh(review)
    return review


@router.delete("/budget-reviews/{review_id}", status_code=204)
def delete_budget_review(review_id: int, db: Session = Depends(get_db)):
    review = _get_review_or_404(db, review_id)
    increment = review.increment
    db.delete(review)
    _budget_changed(db, increment)


@router.post("/budget-reviews/{review_id}/hours", response_model=schemas.BudgetReview, status_code=201)
def create_review_hours(review_id: int, payload: schemas.BudgetReviewHoursWrite, db: Session = Depends(get_db)):
    review = _get_review_or_404(db, review_id)
    data = payload.model_dump(exclude_unset=True)
    department = data.get("department") or budget.DEPARTMENTS[0][0]
    _check_department(department)
    description = (data.get("description") or "").strip()
    if not description:
        raise HTTPException(status_code=400, detail="La descrizione e' obbligatoria")
    order = max((i.order for i in review.hours_items), default=0) + 1
    review.hours_items.append(
        models.IncrementBudgetReviewHours(
            department=department,
            description=description,
            spa=data.get("spa") or 0,
            sa=data.get("sa") or 0,
            tpm=data.get("tpm") or 0,
            order=order,
        )
    )
    _budget_changed(db, review.increment)
    db.refresh(review)
    return review


@router.put("/budget-review-hours/{item_id}", response_model=schemas.BudgetReview)
def update_review_hours(item_id: int, payload: schemas.BudgetReviewHoursWrite, db: Session = Depends(get_db)):
    item = db.get(models.IncrementBudgetReviewHours, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Riga della review non trovata")
    data = payload.model_dump(exclude_unset=True)
    if "department" in data:
        _check_department(data["department"])
    if "description" in data:
        description = (data["description"] or "").strip()
        if not description:
            raise HTTPException(status_code=400, detail="La descrizione e' obbligatoria")
        data["description"] = description
    for field, value in data.items():
        if value is not None:
            setattr(item, field, value)
    review = item.review
    _budget_changed(db, review.increment)
    db.refresh(review)
    return review


@router.delete("/budget-review-hours/{item_id}", response_model=schemas.BudgetReview)
def delete_review_hours(item_id: int, db: Session = Depends(get_db)):
    item = db.get(models.IncrementBudgetReviewHours, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Riga della review non trovata")
    review = item.review
    db.delete(item)
    _budget_changed(db, review.increment)
    db.refresh(review)
    return review


@router.post("/budget-reviews/{review_id}/materials", response_model=schemas.BudgetReview, status_code=201)
def create_review_material(review_id: int, payload: schemas.MaterialWrite, db: Session = Depends(get_db)):
    review = _get_review_or_404(db, review_id)
    order = max((i.order for i in review.material_items), default=0) + 1
    review.material_items.append(
        _new_material(models.IncrementBudgetReviewMaterial, payload.model_dump(exclude_unset=True), order=order)
    )
    _budget_changed(db, review.increment)
    db.refresh(review)
    return review


@router.put("/budget-review-materials/{item_id}", response_model=schemas.BudgetReview)
def update_review_material(item_id: int, payload: schemas.MaterialWrite, db: Session = Depends(get_db)):
    item = db.get(models.IncrementBudgetReviewMaterial, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Riga della review non trovata")
    _apply_material(item, payload.model_dump(exclude_unset=True))
    review = item.review
    _budget_changed(db, review.increment)
    db.refresh(review)
    return review


@router.delete("/budget-review-materials/{item_id}", response_model=schemas.BudgetReview)
def delete_review_material(item_id: int, db: Session = Depends(get_db)):
    item = db.get(models.IncrementBudgetReviewMaterial, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Riga della review non trovata")
    review = item.review
    db.delete(item)
    _budget_changed(db, review.increment)
    db.refresh(review)
    return review
