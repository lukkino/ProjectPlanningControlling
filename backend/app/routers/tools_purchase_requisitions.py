"""Tool RDA: le richieste di acquisto preparate dall'utente in Dynamics 365,
lette col browser dell'app (vedi services/tools/purchase_requisitions.py) e
salvate qui per consultarle e filtrarle.

Le uniche scritture in Dynamics: le righe caricate da un Excel (modello
scaricabile da qui) su una RDA in bozza, dopo l'anteprima confermata
dall'utente (services/tools/purchase_requisition_writer.py). La RDA, la
testata e l'invio all'approvazione restano in Dynamics.

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

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.ownership import scope_user_id, user_settings, user_settings_for_update
from app.routers import change_order
from app.services.tools import requisition_excel
from app.services.tools.purchase_requisitions import DEFAULT_LIST_URL

router = APIRouter(prefix="/api/tools/purchase-requisitions", tags=["tools"])

# Login + elenco + qualche query OData: di solito 15-30 s.
READ_TIMEOUT_S = 300
# Scrittura delle righe: login + qualche secondo a riga.
WRITE_TIMEOUT_S = 900
LINK_TIMEOUT_S = 180

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
    dynamics_url: str | None = None

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
        dynamics_url=r.dynamics_url,
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


# --- Righe da Excel e link a Dynamics -------------------------------------


class ExcelLine(BaseModel):
    row: int
    category: str | None = None
    product: str | None = None
    quantity: float | None = None
    unit: str | None = None
    price: float | None = None
    currency: str = "EUR"
    vendor: str | None = None
    requested_date: dt.date | None = None
    errors: list[str] = []


class ExcelPreview(BaseModel):
    lines: list[ExcelLine]
    # Righe scrivibili e importo totale (righe senza errori).
    valid: int
    total: float
    # Fornitori del file gia' visti nelle RDA dell'utente: codice -> nome.
    vendor_names: dict[str, str] = {}


class WriteLinesRequest(BaseModel):
    lines: list[ExcelLine]


class LineResult(BaseModel):
    row: int
    ok: bool
    line: int | None = None
    error: str | None = None


class WriteLinesResult(BaseModel):
    results: list[LineResult]
    requisition: PurchaseRequisition


class LinkResult(BaseModel):
    url: str


def _get_owned(db: Session, req_id: int) -> models.PurchaseRequisition:
    req = _owned(db).filter(models.PurchaseRequisition.id == req_id).first()
    if req is None:
        raise HTTPException(status_code=404, detail="RDA non trovata")
    return req


def _known_lines(db: Session) -> list[dict]:
    lines: list[dict] = []
    for r in _owned(db):
        lines.extend(json.loads(r.lines_json or "[]"))
    return lines


def _vendor_names(db: Session) -> dict[str, str]:
    return {l["vendor_account"]: l["vendor_name"] for l in _known_lines(db) if l.get("vendor_account") and l.get("vendor_name")}


def _run_browser(request: dict, timeout_s: int, phase: str) -> dict:
    """Esegue purchase_requisition_writer col browser dell'app (uno solo:
    niente letture o Change Order in contemporanea)."""
    global _progress
    if change_order._running():
        raise HTTPException(status_code=409, detail="È aperta la finestra del Change Order: chiudila e riprova.")
    if not change_order._status_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Il browser dell'app è occupato da un'altra lettura: riprova tra poco.")
    _progress = schemas.SyncProgress(phase=phase, done=0, total=0)
    output: list[str] = []
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "app.services.tools.purchase_requisition_writer"],
            cwd=change_order.BACKEND_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        process.stdin.write(json.dumps(request, default=str))
        process.stdin.close()
        timer = threading.Timer(timeout_s, process.kill)
        timer.start()
        try:
            for line in process.stdout:
                if line.startswith("PROGRESS "):
                    _, done, total = line.split()
                    _progress = schemas.SyncProgress(phase=phase, done=int(done), total=int(total))
                else:
                    output.append(line)
            process.wait()
        finally:
            timer.cancel()
    finally:
        change_order._status_lock.release()
        _progress = None
    lines = [line for line in output if line.strip().startswith("{")]
    outcome = json.loads(lines[-1]) if lines else {"error": "nessuna risposta da Dynamics (tempo scaduto?)"}
    if outcome.get("error") == "login":
        raise HTTPException(
            status_code=409,
            detail='Login a Dynamics non riuscito: apri il CO una volta con "Imposta impatto Software" e rifai il login Microsoft.',
        )
    if outcome.get("error"):
        raise HTTPException(status_code=502, detail=f"Dynamics: {outcome['error']}")
    return outcome


@router.get("/lines-template")
def lines_template(db: Session = Depends(get_db)):
    """Modello Excel delle righe, con i menu a tendina presi dalle RDA lette."""
    known = _known_lines(db)

    def distinct(values) -> list[str]:
        return sorted({v for v in values if v}, key=str.lower)

    vendor_names = _vendor_names(db)
    lists = {
        "categories": distinct(l.get("category") for l in known),
        "units": distinct(l.get("unit") for l in known) or ["PZ", "Nr"],
        "currencies": distinct(l.get("currency") for l in known) or ["EUR", "USD"],
        "vendors": distinct(f"{code} - {name}" for code, name in vendor_names.items()),
    }
    return Response(
        content=requisition_excel.template(lists),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="Righe RDA.xlsx"'},
    )


@router.post("/{req_id}/lines/preview", response_model=ExcelPreview)
def preview_lines(
    req_id: int,
    workbook: bytes = Body(..., media_type="application/octet-stream"),
    db: Session = Depends(get_db),
):
    """Legge l'Excel compilato e controlla le righe, senza scrivere niente."""
    _get_owned(db, req_id)
    try:
        lines = [ExcelLine(**line) for line in requisition_excel.parse(workbook)]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not lines:
        raise HTTPException(status_code=400, detail="Nessuna riga compilata nel foglio «Righe».")
    valid = [l for l in lines if not l.errors]
    names = _vendor_names(db)
    return ExcelPreview(
        lines=lines,
        valid=len(valid),
        total=round(sum((l.quantity or 0) * (l.price or 0) for l in valid), 2),
        vendor_names={l.vendor: names[l.vendor] for l in lines if l.vendor in names},
    )


@router.post("/{req_id}/lines", response_model=WriteLinesResult)
def write_lines(req_id: int, payload: WriteLinesRequest, db: Session = Depends(get_db)):
    """Aggiunge in Dynamics le righe (senza errori) alla RDA in bozza e
    aggiorna le righe salvate qui con quelle lette subito dopo."""
    req = _get_owned(db, req_id)
    lines = [l for l in payload.lines if not l.errors]
    if not lines:
        raise HTTPException(status_code=400, detail="Nessuna riga senza errori da scrivere.")
    outcome = _run_browser(
        {
            "action": "add_lines",
            "number": req.number,
            "list_url": _list_url(db),
            "lines": [l.model_dump(exclude={"errors"}) for l in lines],
        },
        WRITE_TIMEOUT_S,
        "lines",
    )
    # Nomi dei fornitori gia' letti dal writer nella societa' della RDA.
    req.lines_json = json.dumps(outcome.get("lines") or [], ensure_ascii=False)
    db.commit()
    return WriteLinesResult(results=outcome.get("results") or [], requisition=_out(req))


@router.post("/{req_id}/link", response_model=LinkResult)
def requisition_link(req_id: int, db: Session = Depends(get_db)):
    """Link alla RDA in Dynamics: quello salvato o, la prima volta, chiesto a
    Dynamics (Opzioni > Ottieni un collegamento) e salvato."""
    req = _get_owned(db, req_id)
    if req.dynamics_url:
        return LinkResult(url=req.dynamics_url)
    outcome = _run_browser({"action": "link", "number": req.number, "list_url": _list_url(db)}, LINK_TIMEOUT_S, "link")
    req.dynamics_url = outcome["url"]
    db.commit()
    return LinkResult(url=req.dynamics_url)
