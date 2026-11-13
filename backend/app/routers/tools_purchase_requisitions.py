"""Tool RDA: le richieste di acquisto preparate dall'utente in Dynamics 365,
lette col browser dell'app (vedi services/tools/purchase_requisitions.py) e
salvate qui per consultarle e filtrarle. Solo lettura: niente viene
modificato in Dynamics.

Il link all'elenco in Dynamics (ambiente e societa') e' un'impostazione
personale. Il browser dell'app pero' e' uno solo, con un solo accesso
Microsoft: si leggono le RDA dell'utente collegato a quel browser. Per non
salvare le RDA di un altro, se l'utente dell'app ha un'email la lettura vale
solo se coincide con l'account Microsoft del browser."""

import datetime as dt
import json
import subprocess
import sys
import threading
import urllib.parse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.ownership import scope_user_id, user_settings, user_settings_for_update
from app.routers import change_order
from app.services.tools.purchase_requisitions import DEFAULT_LIST_URL

router = APIRouter(prefix="/api/tools/purchase-requisitions", tags=["tools"])

# Login + elenco + qualche query OData: di solito 15-30 s.
READ_TIMEOUT_S = 300

_progress: schemas.SyncProgress | None = None


class RequisitionLine(BaseModel):
    line: float | None = None
    status: str | None = None
    product: str | None = None
    description: str | None = None
    item_number: str | None = None
    category: str | None = None
    quantity: float | None = None
    unit: str | None = None
    price: float | None = None
    amount: float | None = None
    currency: str | None = None
    vendor_account: str | None = None
    vendor_name: str | None = None
    project_id: str | None = None
    requested_date: dt.date | None = None


class RequisitionApprover(BaseModel):
    name: str
    # Pending = la RDA e' in carico a questa persona, Completed = approvato.
    status: str | None = None


class PurchaseRequisition(BaseModel):
    id: int
    number: str
    name: str | None
    status: str | None
    project_id: str | None
    legal_entity: str | None
    purpose: str | None
    justification_code: str | None
    justification: str | None
    date: dt.date | None
    requested_date: dt.date | None
    on_hold: bool
    on_hold_explanation: str | None
    lines: list[RequisitionLine] = []
    approvers: list[RequisitionApprover] = []
    in_charge: list[str] = []
    last_action_at: dt.datetime | None = None
    last_action_by: str | None = None
    synced_at: dt.datetime | None

    @field_validator("in_charge", mode="before")
    @classmethod
    def _split(cls, value):
        if isinstance(value, str):
            return [v for v in value.split("; ") if v]
        return value or []

    @field_validator("lines", "approvers", mode="before")
    @classmethod
    def _parse(cls, value):
        if isinstance(value, str):
            return json.loads(value)
        return value or []


class SyncResult(BaseModel):
    created: int
    updated: int
    removed: int
    total: int
    # Account Microsoft con cui Dynamics e' stato letto.
    account: str | None = None


class RequisitionSettings(BaseModel):
    # Link all'elenco "Richieste di acquisto preparate dall'utente".
    list_url: str
    default_url: str = DEFAULT_LIST_URL


def _list_url(db: Session) -> str:
    return (user_settings(db).d365_requisitions_url or "").strip() or DEFAULT_LIST_URL


def _owned(db: Session):
    return db.query(models.PurchaseRequisition).filter(models.PurchaseRequisition.owner_id == scope_user_id())


def _out(r: models.PurchaseRequisition) -> PurchaseRequisition:
    return PurchaseRequisition(
        id=r.id,
        number=r.number,
        name=r.name,
        status=r.status,
        project_id=r.project_id,
        legal_entity=r.legal_entity,
        purpose=r.purpose,
        justification_code=r.justification_code,
        justification=r.justification,
        date=r.date,
        requested_date=r.requested_date,
        on_hold=bool(r.on_hold),
        on_hold_explanation=r.on_hold_explanation,
        lines=r.lines_json,
        approvers=r.approvers_json,
        in_charge=r.in_charge,
        last_action_at=r.last_action_at,
        last_action_by=r.last_action_by,
        synced_at=r.synced_at,
    )


def _to_date(value: str | None) -> dt.date | None:
    return dt.date.fromisoformat(value) if value else None


@router.get("", response_model=list[PurchaseRequisition])
def list_requisitions(db: Session = Depends(get_db)):
    rows = _owned(db).order_by(models.PurchaseRequisition.date.desc(), models.PurchaseRequisition.number.desc()).all()
    return [_out(r) for r in rows]


@router.get("/settings", response_model=RequisitionSettings)
def get_settings(db: Session = Depends(get_db)):
    return RequisitionSettings(list_url=_list_url(db))


@router.put("/settings", response_model=RequisitionSettings)
def update_settings(payload: RequisitionSettings, db: Session = Depends(get_db)):
    url = payload.list_url.strip()
    parts = urllib.parse.urlsplit(url)
    if url and (parts.scheme != "https" or not parts.netloc.endswith(".dynamics.com")):
        raise HTTPException(
            status_code=400,
            detail="Il link deve essere un indirizzo https di Dynamics 365 (…dynamics.com), "
            "es. l'elenco «Richieste di acquisto preparate dall'utente» aperto nel browser.",
        )
    row = user_settings_for_update(db)
    # Il link predefinito non si salva: se cambia, vale per tutti.
    row.d365_requisitions_url = url if url and url != DEFAULT_LIST_URL else None
    db.commit()
    return RequisitionSettings(list_url=_list_url(db))


@router.get("/sync/progress", response_model=schemas.SyncProgress)
def sync_progress():
    return _progress or schemas.SyncProgress(phase="idle")


@router.post("/sync", response_model=SyncResult)
def sync_requisitions(db: Session = Depends(get_db)):
    """Legge le RDA da Dynamics e aggiorna quelle salvate: nuove aggiunte,
    esistenti aggiornate, quelle non piu' in Dynamics rimosse."""
    global _progress
    if change_order._running():
        raise HTTPException(status_code=409, detail="È aperta la finestra del Change Order: chiudila e riprova.")
    if not change_order._status_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Il browser dell'app è occupato da un'altra lettura: riprova tra poco.")
    _progress = schemas.SyncProgress(phase="requisitions", done=0, total=0)
    output: list[str] = []
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "app.services.tools.purchase_requisitions"],
            cwd=change_order.BACKEND_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        process.stdin.write(json.dumps({"list_url": _list_url(db)}))
        process.stdin.close()
        timer = threading.Timer(READ_TIMEOUT_S, process.kill)
        timer.start()
        try:
            for line in process.stdout:
                if line.startswith("PROGRESS "):
                    _, done, total = line.split()
                    _progress = schemas.SyncProgress(phase="requisitions", done=int(done), total=int(total))
                else:
                    output.append(line)
            process.wait()
        finally:
            timer.cancel()
    finally:
        change_order._status_lock.release()
        _progress = None

    lines = [line for line in output if line.strip().startswith("{")]
    outcome = json.loads(lines[-1]) if lines else {"requisitions": [], "error": "nessuna risposta dalla lettura (tempo scaduto?)"}
    if outcome.get("error") == "login":
        raise HTTPException(
            status_code=409,
            detail='Login a Dynamics non riuscito: apri il CO una volta con "Imposta impatto Software" e rifai il login Microsoft.',
        )
    if outcome.get("error"):
        raise HTTPException(status_code=502, detail=f"Dynamics non letto: {outcome['error']}")
    account = outcome.get("account")
    user = db.get(models.User, scope_user_id())
    email = ((user.email if user else None) or "").strip().lower()
    if email and account and account.strip().lower() != email:
        raise HTTPException(
            status_code=409,
            detail=f"Il browser dell'app è collegato a Dynamics con l'account {account}, non con il tuo ({email}): "
            "le RDA lette non sono le tue, niente è stato salvato.",
        )
    read = outcome["requisitions"]
    if not read:
        raise HTTPException(status_code=502, detail="Dynamics non ha restituito nessuna RDA: niente è stato modificato.")

    owner_id = scope_user_id()
    existing = {r.number: r for r in _owned(db)}
    now = dt.datetime.utcnow()
    created = updated = 0
    for row in read:
        req = existing.pop(row["number"], None)
        if req is None:
            req = models.PurchaseRequisition(owner_id=owner_id, number=row["number"])
            db.add(req)
            created += 1
        else:
            updated += 1
        req.name = row.get("name")
        req.status = row.get("status")
        req.project_id = row.get("project_id")
        req.legal_entity = row.get("legal_entity")
        req.purpose = row.get("purpose")
        req.justification_code = row.get("justification_code")
        req.justification = row.get("justification")
        req.date = _to_date(row.get("date"))
        req.requested_date = _to_date(row.get("requested_date"))
        req.on_hold = bool(row.get("on_hold"))
        req.on_hold_explanation = row.get("on_hold_explanation")
        req.lines_json = json.dumps(row.get("lines") or [], ensure_ascii=False)
        req.approvers_json = json.dumps(row.get("approvers") or [], ensure_ascii=False)
        req.in_charge = "; ".join(row.get("in_charge") or []) or None
        # Ultima azione: letta solo per le RDA col flusso in corso; per le
        # altre resta l'ultima letta.
        if row.get("workflow_read"):
            action = row.get("last_action") or {}
            req.last_action_at = dt.datetime.fromisoformat(action["at"]) if action.get("at") else None
            req.last_action_by = action.get("by")
        req.synced_at = now
    for req in existing.values():
        db.delete(req)
    db.commit()
    return SyncResult(created=created, updated=updated, removed=len(existing), total=len(read), account=account)
