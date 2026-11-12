"""Tool Ticket certificazioni: i ticket del portale Product Certification
(Freshservice), letti dal portale col browser dell'app (vedi
services/tools/certification_tickets.py) e salvati qui per consultarli e
filtrarli."""

import datetime as dt
import json
import subprocess
import sys
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.ownership import scope_user_id
from app.routers import change_order

router = APIRouter(prefix="/api/tools/certification-tickets", tags=["tools"])

PORTAL_URL = "https://inpeco-prodcertification.freshservice.com"
# Login + elenco + una pagina per ticket (qualche secondo l'una).
READ_TIMEOUT_S = 600

# Avanzamento della lettura in corso, letto dal popup del frontend mentre la
# POST e' in attesa (come per la sync del Backlog).
_progress: schemas.SyncProgress | None = None
_progress_lock = threading.Lock()


class CertificationTicket(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    ticket_id: int
    display_id: str | None
    subject: str | None
    status: str | None
    created_at: dt.datetime | None
    assigned_to: str | None
    stage: str | None
    # Campi della richiesta e del ticket: {etichetta: valore}.
    item: dict[str, str | None] = {}
    ticket: dict[str, str | None] = {}
    replies: int
    synced_at: dt.datetime | None
    url: str = ""

    @field_validator("item", "ticket", mode="before")
    @classmethod
    def _parse(cls, value):
        if isinstance(value, str):
            return json.loads(value)
        return value or {}


class SyncResult(BaseModel):
    created: int
    updated: int
    removed: int
    total: int


def _owned(db: Session):
    return db.query(models.CertificationTicket).filter(models.CertificationTicket.owner_id == scope_user_id())


def _out(t: models.CertificationTicket) -> CertificationTicket:
    return CertificationTicket(
        id=t.id,
        ticket_id=t.ticket_id,
        display_id=t.display_id,
        subject=t.subject,
        status=t.status,
        created_at=t.created_at,
        assigned_to=t.assigned_to,
        stage=t.stage,
        item=t.item_json,
        ticket=t.ticket_json,
        replies=t.replies or 0,
        synced_at=t.synced_at,
        url=f"{PORTAL_URL}/support/tickets/{t.ticket_id}",
    )


@router.get("", response_model=list[CertificationTicket])
def list_tickets(db: Session = Depends(get_db)):
    tickets = _owned(db).order_by(models.CertificationTicket.ticket_id.desc()).all()
    return [_out(t) for t in tickets]


@router.get("/sync/progress", response_model=schemas.SyncProgress)
def sync_progress():
    return _progress or schemas.SyncProgress(phase="idle")


@router.post("/sync", response_model=SyncResult)
def sync_tickets(db: Session = Depends(get_db)):
    """Legge tutti i ticket dal portale e aggiorna quelli salvati: nuovi
    aggiunti, esistenti aggiornati, quelli non piu' nel portale rimossi."""
    global _progress
    if change_order._running():
        raise HTTPException(status_code=409, detail="È aperta la finestra del Change Order: chiudila e riprova.")
    if not change_order._status_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Il browser dell'app è occupato da un'altra lettura: riprova tra poco.")
    _progress = schemas.SyncProgress(phase="tickets", done=0, total=0)
    output: list[str] = []
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "app.services.tools.certification_tickets"],
            cwd=change_order.BACKEND_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        timer = threading.Timer(READ_TIMEOUT_S, process.kill)
        timer.start()
        try:
            for line in process.stdout:
                if line.startswith("PROGRESS "):
                    _, done, total = line.split()
                    _progress = schemas.SyncProgress(phase="tickets", done=int(done), total=int(total))
                else:
                    output.append(line)
            process.wait()
        finally:
            timer.cancel()
    finally:
        change_order._status_lock.release()
        _progress = None

    lines = [line for line in output if line.strip().startswith("{")]
    outcome = json.loads(lines[-1]) if lines else {"tickets": [], "error": "nessuna risposta dalla lettura (tempo scaduto?)"}
    if outcome.get("error") == "login":
        raise HTTPException(
            status_code=409,
            detail='Login al portale non riuscito: apri il CO una volta con "Imposta impatto Software" e rifai il login Microsoft.',
        )
    if outcome.get("error"):
        raise HTTPException(status_code=502, detail=f"Portale non letto: {outcome['error']}")
    read = outcome["tickets"]
    if not read:
        raise HTTPException(status_code=502, detail="Il portale non ha restituito nessun ticket: niente è stato modificato.")

    owner_id = scope_user_id()
    existing = {t.ticket_id: t for t in _owned(db)}
    now = dt.datetime.utcnow()
    created = updated = 0
    for row in read:
        ticket = existing.pop(row["id"], None)
        if ticket is None:
            ticket = models.CertificationTicket(owner_id=owner_id, ticket_id=row["id"])
            db.add(ticket)
            created += 1
        else:
            updated += 1
        ticket.display_id = row.get("display_id")
        ticket.subject = row.get("subject")
        ticket.status = row.get("status")
        ticket.created_at = dt.datetime.fromisoformat(row["created_at"]) if row.get("created_at") else None
        ticket.assigned_to = row.get("assigned_to")
        ticket.stage = row.get("stage")
        ticket.item_json = json.dumps(row.get("item") or {}, ensure_ascii=False)
        ticket.ticket_json = json.dumps(row.get("ticket") or {}, ensure_ascii=False)
        ticket.replies = row.get("replies") or 0
        ticket.synced_at = now
    for ticket in existing.values():
        db.delete(ticket)
    db.commit()
    return SyncResult(created=created, updated=updated, removed=len(existing), total=len(read))
