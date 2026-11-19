"""Actual dei materiali di un progetto dalle RDA del tool RDA (Dynamics).

Contano le RDA del progetto (ID progetto Dynamics che inizia col codice del
progetto, es. PTIH-PT13-004 -> PTIH-PT13) con data entro quella dello
snapshot, tranne rifiutate e annullate: in bozza, in revisione, approvate e
chiuse impegnano gia' il budget (come il riquadro budget del tool RDA).

Ogni riga di RDA va su una voce di spesa dello Storico in base al
sottoprogetto Dynamics della riga, cioe' il suffisso dell'ID progetto
(PTIH-PT13-004 -> 004), che in Dynamics separa le voci del budget:
- 001 -> Feasibility
- 002 -> Prototype
- 003 -> Pre Serie
- 004 -> Consultancies
- 005 -> Travel Expenses
Senza suffisso noto (o se la voce non c'e' nello Storico) decide la
categoria Dynamics della riga: "Consulenze ..." -> Consultancies,
viaggi/trasferte -> Travel Expenses, il resto -> la prima voce di materiali
dello Storico (Prototype, Preserie...).
"""

import datetime as dt
import json
import re

from sqlalchemy.orm import Session

from app import models
from app.services.budget import _line_for_category

# RDA che non impegnano budget.
NOT_COMMITTED_STATUSES = {"Rejected", "Cancelled"}
STATUS_LABELS = {
    "Draft": "Bozza",
    "InReview": "In revisione",
    "Approved": "Approvata",
    "Closed": "Chiusa",
}

# Sottoprogetto Dynamics (suffisso dell'ID progetto) -> voce del budget.
SUFFIX_CATEGORIES = {
    "001": "Feasibility",
    "002": "Prototype",
    "003": "Pre Serie",
    "004": "Consultancies",
    "005": "Travel Expenses",
}

_CONSULTANCY = re.compile(r"consulen", re.I)
_TRAVEL = re.compile(r"viagg|trasfert|travel|hotel|alberg|vol[io]\b|treno|vitto|alloggi", re.I)
_SPECIAL_LINES = {"consultancies", "consultancy", "travel expenses", "travels", "travel"}


def _project_requisitions(db: Session, increment: models.Increment) -> list[models.PurchaseRequisition]:
    """RDA del progetto: l'ID progetto e' il codice o ne inizia con
    "<codice>-", e non appartiene a un progetto dell'utente con un codice
    piu' lungo (piu' specifico)."""
    code = increment.code.upper()
    others = [
        i.code.upper()
        for i in db.query(models.Increment).filter(models.Increment.owner_id == increment.owner_id)
        if i.id != increment.id and len(i.code) > len(code)
    ]

    def belongs(project_id: str, prefix: str) -> bool:
        return project_id == prefix or project_id.startswith(prefix + "-")

    return [
        r
        for r in db.query(models.PurchaseRequisition).filter(models.PurchaseRequisition.owner_id == increment.owner_id)
        if r.project_id
        and belongs(r.project_id.upper(), code)
        and not any(belongs(r.project_id.upper(), o) for o in others)
    ]


def _material_line(increment: models.Increment) -> models.IncrementBudgetLine | None:
    return next(
        (
            line
            for line in sorted(increment.budget_lines, key=lambda l: l.order)
            if not line.is_hours and line.category_name.strip().lower() not in _SPECIAL_LINES
        ),
        None,
    )


def has_requisitions(db: Session, increment: models.Increment) -> bool:
    return bool(_project_requisitions(db, increment))


def requisition_actuals(db: Session, increment: models.Increment, until: dt.date) -> dict[int, list[dict]]:
    """Per voce di spesa dello Storico (id voce): le RDA che la compongono,
    [{"number", "name", "status", "amount"}], fino a `until` compreso."""
    material = _material_line(increment)
    by_line: dict[int, dict[str, dict]] = {}
    for requisition in _project_requisitions(db, increment):
        if requisition.status in NOT_COMMITTED_STATUSES:
            continue
        if requisition.date and requisition.date > until:
            continue
        for row in json.loads(requisition.lines_json or "[]"):
            project_id = (row.get("project_id") or requisition.project_id or "").upper()
            suffix = project_id[len(increment.code) + 1:].split("-")[0]
            line = None
            if suffix in SUFFIX_CATEGORIES:
                line = _line_for_category(increment, SUFFIX_CATEGORIES[suffix])
            if line is None:
                category = row.get("category") or ""
                if _CONSULTANCY.search(category):
                    line = _line_for_category(increment, "Consultancies")
                elif _TRAVEL.search(category):
                    line = _line_for_category(increment, "Travel Expenses")
            line = line or material
            if line is None:
                continue
            entry = by_line.setdefault(line.id, {}).setdefault(
                requisition.number,
                {
                    "number": requisition.number,
                    "name": requisition.name,
                    "status": STATUS_LABELS.get(requisition.status or "", requisition.status),
                    "project_id": project_id or None,
                    "amount": 0.0,
                },
            )
            entry["amount"] += row.get("amount") or 0
    return {
        line_id: sorted(
            ({**r, "amount": round(r["amount"], 2)} for r in rdas.values()), key=lambda r: r["number"]
        )
        for line_id, rdas in by_line.items()
    }
