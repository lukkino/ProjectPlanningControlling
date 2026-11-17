"""Tool Enhancements: gli Enhancement (Opportunity) di una list view di
Salesforce (di default "Enhancement ProTube"), letti col browser dell'app
(vedi services/tools/enhancements.py) e salvati qui per consultarli. Solo
lettura: niente viene modificato in Salesforce.

Il link alla list view e' un'impostazione personale (vuota = quella
predefinita). Ogni enhancement con l'ID Jira (campo Salesforce che verra'
aggiunto) viene confrontato con il backlog degli increment dell'utente: si
vede in quale increment e' e con che stato Jira, e quali enhancement non
hanno ancora un corrispettivo su Jira."""

import datetime as dt
import json
import re
import subprocess
import sys
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.ownership import scope_user_id, user_settings, user_settings_for_update
from app.routers import change_order
from app.services.tools.enhancements import DEFAULT_LIST_URL, parse_list_url, record_url

router = APIRouter(prefix="/api/tools/enhancements", tags=["tools"])

# Login + 4 chiamate REST: di solito 10-20 s.
READ_TIMEOUT_S = 300
JIRA_KEY_RE = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")

_progress: schemas.SyncProgress | None = None


class JiraMatch(BaseModel):
    # Issue Jira citata dall'enhancement e, se e' nel backlog di un
    # increment dell'utente, dove.
    key: str
    increment_id: int | None = None
    increment_code: str | None = None
    summary: str | None = None
    jira_status: str | None = None


class Enhancement(BaseModel):
    id: int
    sf_id: str
    request_id: str | None
    name: str | None
    stage: str | None
    priority: str | None
    enhancement_type: str | None
    source: str | None
    product_line: str | None
    target_release: str | None
    expected_due_date: dt.date | None
    release_date: dt.date | None
    short_description: str | None
    accounts: str | None
    cases: str | None
    is_closed: bool
    sf_owner: str | None
    created_by: str | None
    jira_key: str | None
    jira: list[JiraMatch] = []
    # Increment associato a mano (vedi PUT /{id}).
    increment_id: int | None = None
    increment_code: str | None = None
    created_at: dt.datetime | None
    modified_at: dt.datetime | None
    synced_at: dt.datetime | None
    url: str


class EnhancementUpdate(BaseModel):
    increment_id: int | None = None


class EnhancementsSettings(BaseModel):
    # Link alla list view Salesforce degli enhancement.
    list_url: str
    default_url: str = DEFAULT_LIST_URL
    # Nome del campo Salesforce con l'ID Jira (null = non ancora presente).
    jira_field: str | None = None


class SyncResult(BaseModel):
    created: int
    updated: int
    removed: int
    total: int
    view: str | None = None
    jira_field: str | None = None


def _list_url(db: Session) -> str:
    return (user_settings(db).enh_list_url or "").strip() or DEFAULT_LIST_URL


def _settings(db: Session) -> EnhancementsSettings:
    return EnhancementsSettings(list_url=_list_url(db), jira_field=user_settings(db).enh_jira_field)


def _owned(db: Session):
    return db.query(models.SalesforceEnhancement).filter(models.SalesforceEnhancement.owner_id == scope_user_id())


def _backlog_by_key(db: Session, keys: set[str]) -> dict[str, models.BacklogItem]:
    """Item del backlog (non archiviati) degli increment dell'utente."""
    if not keys:
        return {}
    rows = (
        db.query(models.BacklogItem)
        .join(models.Project, models.Project.id == models.BacklogItem.project_id)
        .filter(
            models.Project.owner_id == scope_user_id(),
            models.BacklogItem.jira_key.in_(keys),
            models.BacklogItem.archived_at.is_(None),
        )
        .all()
    )
    return {r.jira_key: r for r in rows}


def _increments(db: Session) -> dict[int, models.Project]:
    """Increment dell'utente (quelli che puo' associare)."""
    return {p.id: p for p in db.query(models.Project).filter(models.Project.owner_id == scope_user_id())}


def _out(e: models.SalesforceEnhancement, matches: list[JiraMatch], increments: dict[int, models.Project]) -> Enhancement:
    increment = increments.get(e.increment_id) if e.increment_id else None
    return Enhancement.model_validate(
        {
            **{c.name: getattr(e, c.name) for c in models.SalesforceEnhancement.__table__.columns},
            "jira": matches,
            "url": record_url(e.sf_id),
            # Un increment cancellato (o di un altro utente) non conta.
            "increment_id": increment.id if increment else None,
            "increment_code": increment.code if increment else None,
        }
    )


@router.get("", response_model=list[Enhancement])
def list_enhancements(db: Session = Depends(get_db)):
    rows = _owned(db).order_by(models.SalesforceEnhancement.request_id.desc()).all()
    keys_of = {e.id: JIRA_KEY_RE.findall((e.jira_key or "").upper()) for e in rows}
    backlog = _backlog_by_key(db, {k for keys in keys_of.values() for k in keys})
    increments = _increments(db)
    out = []
    for e in rows:
        matches = []
        for key in keys_of[e.id]:
            item = backlog.get(key)
            matches.append(
                JiraMatch(
                    key=key,
                    increment_id=item.project_id if item else None,
                    increment_code=item.project.code if item else None,
                    summary=item.summary if item else None,
                    jira_status=item.jira_status if item else None,
                )
            )
        out.append(_out(e, matches, increments))
    return out


@router.put("/{enhancement_id}", response_model=Enhancement)
def update_enhancement(enhancement_id: int, payload: EnhancementUpdate, db: Session = Depends(get_db)):
    """Associa (o toglie, con null) un increment all'enhancement."""
    enh = _owned(db).filter(models.SalesforceEnhancement.id == enhancement_id).first()
    if enh is None:
        raise HTTPException(status_code=404, detail="Enhancement non trovato")
    increments = _increments(db)
    if payload.increment_id is not None and payload.increment_id not in increments:
        raise HTTPException(status_code=400, detail="Increment non trovato")
    enh.increment_id = payload.increment_id
    db.commit()
    keys = JIRA_KEY_RE.findall((enh.jira_key or "").upper())
    backlog = _backlog_by_key(db, set(keys))
    matches = [
        JiraMatch(
            key=k,
            increment_id=backlog[k].project_id if k in backlog else None,
            increment_code=backlog[k].project.code if k in backlog else None,
            summary=backlog[k].summary if k in backlog else None,
            jira_status=backlog[k].jira_status if k in backlog else None,
        )
        for k in keys
    ]
    return _out(enh, matches, increments)


@router.get("/settings", response_model=EnhancementsSettings)
def get_settings(db: Session = Depends(get_db)):
    return _settings(db)


@router.put("/settings", response_model=EnhancementsSettings)
def update_settings(payload: EnhancementsSettings, db: Session = Depends(get_db)):
    url = payload.list_url.strip()
    if url:
        try:
            parse_list_url(url)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Link non valido ({exc}): apri la list view degli enhancement in Salesforce e copia qui "
                "l'indirizzo dalla barra del browser (es. https://….lightning.force.com/lightning/o/Opportunity/"
                "list?filterName=…).",
            ) from exc
    row = user_settings_for_update(db)
    # Il link predefinito non si salva: se cambia, vale per tutti.
    row.enh_list_url = url if url and url != DEFAULT_LIST_URL else None
    db.commit()
    return _settings(db)


@router.get("/sync/progress", response_model=schemas.SyncProgress)
def sync_progress():
    return _progress or schemas.SyncProgress(phase="idle")


def _to_date(value: str | None) -> dt.date | None:
    return dt.date.fromisoformat(value[:10]) if value else None


def _to_datetime(value: str | None) -> dt.datetime | None:
    """Data Salesforce in UTC ("2026-10-01T13:58:25.000+0000"), salvata in
    UTC senza fuso come le altre date dell'app."""
    if not value:
        return None
    return dt.datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")


def _text(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


@router.post("/sync", response_model=SyncResult)
def sync_enhancements(db: Session = Depends(get_db)):
    """Legge gli enhancement della list view e aggiorna quelli salvati: nuovi
    aggiunti, esistenti aggiornati, quelli non piu' nella vista rimossi."""
    global _progress
    if change_order._running():
        raise HTTPException(status_code=409, detail="È aperta la finestra del Change Order: chiudila e riprova.")
    if not change_order._status_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Il browser dell'app è occupato da un'altra lettura: riprova tra poco.")
    _progress = schemas.SyncProgress(phase="enhancements", done=0, total=3)
    output: list[str] = []
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "app.services.tools.enhancements"],
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
                    _progress = schemas.SyncProgress(phase="enhancements", done=int(done), total=int(total))
                else:
                    output.append(line)
            process.wait()
        finally:
            timer.cancel()
    finally:
        change_order._status_lock.release()
        _progress = None

    lines = [line for line in output if line.strip().startswith("{")]
    outcome = json.loads(lines[-1]) if lines else {"enhancements": [], "error": "nessuna risposta dalla lettura (tempo scaduto?)"}
    if outcome.get("error") == "login":
        raise HTTPException(
            status_code=409,
            detail='Login a Salesforce non riuscito: apri il CO una volta con "Imposta impatto Software" e rifai il login Microsoft.',
        )
    if outcome.get("error"):
        raise HTTPException(status_code=502, detail=f"Salesforce non letto: {outcome['error']}")
    read = outcome["enhancements"]
    if not read:
        raise HTTPException(status_code=502, detail="La list view non ha restituito nessun enhancement: niente è stato modificato.")

    owner_id = scope_user_id()
    existing = {e.sf_id: e for e in _owned(db)}
    now = dt.datetime.utcnow()
    created = updated = 0
    for row in read:
        enh = existing.pop(row["sf_id"], None)
        if enh is None:
            enh = models.SalesforceEnhancement(owner_id=owner_id, sf_id=row["sf_id"])
            db.add(enh)
            created += 1
        else:
            updated += 1
        for field in (
            "request_id",
            "name",
            "stage",
            "priority",
            "enhancement_type",
            "source",
            "target_release",
            "short_description",
            "accounts",
            "cases",
            "created_by",
            "jira_key",
        ):
            setattr(enh, field, _text(row.get(field)))
        # Multipicklist: valori separati da ";".
        enh.product_line = _text((row.get("product_line") or "").replace(";", ", "))
        enh.accounts = _text((row.get("accounts") or "").replace(";", ", "))
        enh.sf_owner = _text(row.get("owner"))
        enh.is_closed = bool(row.get("is_closed"))
        enh.expected_due_date = _to_date(row.get("expected_due_date"))
        enh.release_date = _to_date(row.get("release_date"))
        enh.created_at = _to_datetime(row.get("created_at"))
        enh.modified_at = _to_datetime(row.get("modified_at"))
        enh.synced_at = now
    for enh in existing.values():
        db.delete(enh)
    settings = user_settings_for_update(db)
    settings.enh_jira_field = outcome.get("jira_field")
    db.commit()
    return SyncResult(
        created=created,
        updated=updated,
        removed=len(existing),
        total=len(read),
        view=outcome.get("view"),
        jira_field=outcome.get("jira_field"),
    )
