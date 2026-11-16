"""Tool Commercial Coding: i ticket della lista SharePoint "Tickets" (sito
Development) creati dall'utente, letti col browser dell'app (vedi
services/tools/commercial_coding.py) e salvati qui per consultarli e
filtrarli. Solo lettura: niente viene modificato in SharePoint.

Il link alla lista e' un'impostazione personale (vuota = la lista
predefinita): un altro PJM puo' usare un'altra lista. Il browser dell'app
e' uno solo, con un solo accesso Microsoft: si leggono i
ticket dell'utente collegato a quel browser. Per non salvare i ticket di un
altro, se l'utente dell'app ha un'email la lettura vale solo se coincide con
l'account Microsoft del browser (come per le RDA)."""

import datetime as dt
import json
import subprocess
import sys
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.ownership import scope_user_id, user_settings, user_settings_for_update
from app.routers import change_order
from app.services.tools.commercial_coding import DEFAULT_LIST_URL, item_url, parse_list_url

router = APIRouter(prefix="/api/tools/commercial-coding", tags=["tools"])

CERTIFICATION_PORTAL_URL = "https://inpeco-prodcertification.freshservice.com"
# Login + qualche chiamata REST: di solito 10-20 s.
READ_TIMEOUT_S = 300

_progress: schemas.SyncProgress | None = None


class CommercialCodingTicket(BaseModel):
    id: int
    item_id: int
    description: str | None
    vendor: str | None
    vendor_code: str | None
    family: str | None
    status: str | None
    final_coding: str | None
    change_reason: str | None
    certification_ticket: str | None
    department: str | None
    agent: str | None
    author: str | None
    has_attachments: bool
    details: dict[str, str | None] = {}
    created_at: dt.datetime | None
    modified_at: dt.datetime | None
    synced_at: dt.datetime | None
    url: str
    certification_url: str | None = None

    @field_validator("details", mode="before")
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
    account: str | None = None


class CommercialCodingSettings(BaseModel):
    # Link alla lista SharePoint dei ticket (una vista qualsiasi).
    list_url: str
    default_url: str = DEFAULT_LIST_URL


def _list_url(db: Session) -> str:
    return (user_settings(db).cc_tickets_url or "").strip() or DEFAULT_LIST_URL


def _owned(db: Session):
    return db.query(models.CommercialCodingTicket).filter(models.CommercialCodingTicket.owner_id == scope_user_id())


def _out(t: models.CommercialCodingTicket, list_url: str) -> CommercialCodingTicket:
    cert = (t.certification_ticket or "").strip().lstrip("#")
    return CommercialCodingTicket(
        id=t.id,
        item_id=t.item_id,
        description=t.description,
        vendor=t.vendor,
        vendor_code=t.vendor_code,
        family=t.family,
        status=t.status,
        final_coding=t.final_coding,
        change_reason=t.change_reason,
        certification_ticket=t.certification_ticket,
        department=t.department,
        agent=t.agent,
        author=t.author,
        has_attachments=bool(t.has_attachments),
        details=t.details_json,
        created_at=t.created_at,
        modified_at=t.modified_at,
        synced_at=t.synced_at,
        url=item_url(list_url, t.item_id),
        # Il numero e' quello del ticket nel portale (318 = #CASE-318).
        certification_url=f"{CERTIFICATION_PORTAL_URL}/support/tickets/{cert}" if cert.isdigit() else None,
    )


def _to_datetime(value: str | None) -> dt.datetime | None:
    """Data SharePoint in UTC ("2026-10-07T14:30:32Z"), salvata in UTC senza
    fuso come le altre date dell'app."""
    if not value:
        return None
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)


@router.get("", response_model=list[CommercialCodingTicket])
def list_tickets(db: Session = Depends(get_db)):
    rows = _owned(db).order_by(models.CommercialCodingTicket.item_id.desc()).all()
    list_url = _list_url(db)
    return [_out(t, list_url) for t in rows]


@router.get("/settings", response_model=CommercialCodingSettings)
def get_settings(db: Session = Depends(get_db)):
    return CommercialCodingSettings(list_url=_list_url(db))


@router.put("/settings", response_model=CommercialCodingSettings)
def update_settings(payload: CommercialCodingSettings, db: Session = Depends(get_db)):
    url = payload.list_url.strip()
    if url:
        try:
            parse_list_url(url)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Link non valido ({exc}): apri la lista dei ticket in SharePoint e copia qui l'indirizzo "
                "dalla barra del browser (es. https://….sharepoint.com/sites/…/Lists/Tickets/AllItems.aspx).",
            ) from exc
    row = user_settings_for_update(db)
    # Il link predefinito non si salva: se cambia, vale per tutti.
    row.cc_tickets_url = url if url and url != DEFAULT_LIST_URL else None
    db.commit()
    return CommercialCodingSettings(list_url=_list_url(db))


@router.get("/sync/progress", response_model=schemas.SyncProgress)
def sync_progress():
    return _progress or schemas.SyncProgress(phase="idle")


@router.post("/sync", response_model=SyncResult)
def sync_tickets(db: Session = Depends(get_db)):
    """Legge i ticket da SharePoint e aggiorna quelli salvati: nuovi aggiunti,
    esistenti aggiornati, quelli non piu' nella lista rimossi."""
    global _progress
    if change_order._running():
        raise HTTPException(status_code=409, detail="È aperta la finestra del Change Order: chiudila e riprova.")
    if not change_order._status_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Il browser dell'app è occupato da un'altra lettura: riprova tra poco.")
    _progress = schemas.SyncProgress(phase="tickets", done=0, total=0)
    output: list[str] = []
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "app.services.tools.commercial_coding"],
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
            detail='Login a SharePoint non riuscito: apri il CO una volta con "Imposta impatto Software" e rifai il login Microsoft.',
        )
    if outcome.get("error"):
        raise HTTPException(status_code=502, detail=f"SharePoint non letto: {outcome['error']}")
    account = outcome.get("account")
    user = db.get(models.User, scope_user_id())
    email = ((user.email if user else None) or "").strip().lower()
    if email and account and account.strip().lower() != email:
        raise HTTPException(
            status_code=409,
            detail=f"Il browser dell'app è collegato a SharePoint con l'account {account}, non con il tuo ({email}): "
            "i ticket letti non sono i tuoi, niente è stato salvato.",
        )
    read = outcome["tickets"]
    if not read:
        raise HTTPException(status_code=502, detail="SharePoint non ha restituito nessun ticket: niente è stato modificato.")

    owner_id = scope_user_id()
    existing = {t.item_id: t for t in _owned(db)}
    now = dt.datetime.utcnow()
    created = updated = 0
    for row in read:
        ticket = existing.pop(row["item_id"], None)
        if ticket is None:
            ticket = models.CommercialCodingTicket(owner_id=owner_id, item_id=row["item_id"])
            db.add(ticket)
            created += 1
        else:
            updated += 1
        for field in (
            "description",
            "vendor",
            "vendor_code",
            "family",
            "status",
            "final_coding",
            "change_reason",
            "certification_ticket",
            "department",
            "agent",
            "author",
        ):
            setattr(ticket, field, row.get(field))
        ticket.has_attachments = bool(row.get("has_attachments"))
        ticket.details_json = json.dumps(row.get("details") or {}, ensure_ascii=False)
        ticket.created_at = _to_datetime(row.get("created_at"))
        ticket.modified_at = _to_datetime(row.get("modified_at"))
        ticket.synced_at = now
    for ticket in existing.values():
        db.delete(ticket)
    db.commit()
    return SyncResult(created=created, updated=updated, removed=len(existing), total=len(read), account=account)
