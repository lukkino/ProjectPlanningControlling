"""Tool CVE: i bug Jira di sicurezza (di default quelli aperti dalla
pipeline delle vulnerabilita', vedi models.DEFAULT_CVE_JQL), letti da una
JQL modificabile dall'utente e salvati qui per consultarli e filtrarli.
Solo lettura: niente viene modificato in Jira."""

import datetime as dt
import json
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.ownership import scope_user_id, user_settings, user_settings_for_update
from app.routers.settings import SETTINGS_ROW_ID
from app.services.jira_client import JiraClientError, fetch_cves, test_connection

router = APIRouter(prefix="/api/tools/cve", tags=["tools"])

# Avanzamento della sync in corso, letto dal popup del frontend mentre la
# POST e' in attesa (come per la sync del Backlog).
_progress: schemas.SyncProgress | None = None
_sync_lock = threading.Lock()


class CveIssue(BaseModel):
    id: int
    jira_key: str
    summary: str | None
    cve_ids: list[str]
    package: str | None
    status: str | None
    status_category: str | None
    priority: str | None
    severity: str | None
    cvss_base: float | None
    cvss_inpeco: float | None
    discovered_in: str | None
    fix_versions: list[str]
    labels: list[str]
    components: list[str]
    assignee: str | None
    rejection_reason: str | None
    created: dt.date | None
    updated: dt.datetime | None
    resolved: dt.date | None
    synced_at: dt.datetime | None


class CveSettings(BaseModel):
    jql: str
    # True se la JQL e' quella predefinita (non personalizzata).
    is_default: bool = False


class CveSyncResult(BaseModel):
    created: int
    updated: int
    removed: int
    total: int


def _jql(db: Session) -> str:
    return (user_settings(db).cve_jql or "").strip() or models.DEFAULT_CVE_JQL


def _settings(db: Session) -> CveSettings:
    jql = _jql(db)
    return CveSettings(jql=jql, is_default=jql == models.DEFAULT_CVE_JQL)


def _owned(db: Session):
    return db.query(models.CveIssue).filter(models.CveIssue.owner_id == scope_user_id())


def _json_list(value: str | None) -> list[str]:
    try:
        parsed = json.loads(value) if value else []
    except ValueError:
        return []
    return [str(v) for v in parsed] if isinstance(parsed, list) else []


def _out(c: models.CveIssue) -> CveIssue:
    return CveIssue(
        id=c.id,
        jira_key=c.jira_key,
        summary=c.summary,
        cve_ids=[v for v in (c.cve_ids or "").split(",") if v],
        package=c.package,
        status=c.status,
        status_category=c.status_category,
        priority=c.priority,
        severity=c.severity,
        cvss_base=c.cvss_base,
        cvss_inpeco=c.cvss_inpeco,
        discovered_in=c.discovered_in,
        fix_versions=_json_list(c.fix_versions_json),
        labels=_json_list(c.labels_json),
        components=_json_list(c.components_json),
        assignee=c.assignee,
        rejection_reason=c.rejection_reason,
        created=c.created,
        updated=c.updated,
        resolved=c.resolved,
        synced_at=c.synced_at,
    )


@router.get("", response_model=list[CveIssue])
def list_cves(db: Session = Depends(get_db)):
    rows = _owned(db).order_by(models.CveIssue.created.desc(), models.CveIssue.jira_key.desc()).all()
    return [_out(c) for c in rows]


@router.get("/settings", response_model=CveSettings)
def get_settings(db: Session = Depends(get_db)):
    return _settings(db)


@router.put("/settings", response_model=CveSettings)
def update_settings(payload: CveSettings, db: Session = Depends(get_db)):
    jql = payload.jql.strip()
    row = user_settings_for_update(db)
    # La JQL predefinita non si salva: se cambia, vale per tutti.
    row.cve_jql = jql if jql and jql != models.DEFAULT_CVE_JQL else None
    db.commit()
    return _settings(db)


@router.get("/sync/progress", response_model=schemas.SyncProgress)
def sync_progress():
    return _progress or schemas.SyncProgress(phase="idle")


@router.post("/sync", response_model=CveSyncResult)
def sync_cves(db: Session = Depends(get_db)):
    """Legge da Jira le issue della JQL e riallinea quelle salvate: nuove
    aggiunte, esistenti aggiornate, quelle non piu' nella JQL rimosse."""
    global _progress
    if not _sync_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Una sincronizzazione delle CVE è già in corso: attendi che finisca.")
    try:
        _progress = schemas.SyncProgress(phase="search", done=0, total=0)

        def on_progress(phase: str, done: int, total: int) -> None:
            global _progress
            _progress = schemas.SyncProgress(phase=phase, done=done, total=total)

        settings_row = db.get(models.AppSettings, SETTINGS_ROW_ID)
        base_url = (settings_row.jira_base_url if settings_row else None) or ""
        email = (settings_row.jira_email if settings_row else None) or ""
        api_token = (settings_row.jira_api_token if settings_row else None) or ""
        jql = _jql(db)
        try:
            # Credenziali prima di tutto: con un token scaduto la ricerca
            # risponde 200 con zero issue (vedi la sync del Backlog).
            test_connection(base_url, email, api_token)
            issues = fetch_cves(base_url, email, api_token, jql, on_progress)
        except JiraClientError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        existing = {c.jira_key: c for c in _owned(db)}
        # Zero issue con CVE gia' salvate: quasi sempre una JQL sbagliata (o
        # una fixVersion rinominata), non un elenco davvero vuoto.
        if not issues and existing:
            raise HTTPException(
                status_code=400,
                detail="La JQL non ha restituito nessuna issue: sincronizzazione annullata, le CVE salvate non sono state modificate.",
            )

        on_progress("saving", len(issues), len(issues))
        owner_id = scope_user_id()
        now = dt.datetime.utcnow()
        created = updated = 0
        for issue in issues:
            row = existing.pop(issue.key, None)
            if row is None:
                row = models.CveIssue(owner_id=owner_id, jira_key=issue.key)
                db.add(row)
                created += 1
            else:
                updated += 1
            row.summary = issue.summary
            row.cve_ids = ",".join(issue.cve_ids) or None
            row.package = issue.package
            row.status = issue.status
            row.status_category = issue.status_category
            row.priority = issue.priority
            row.severity = issue.severity
            row.cvss_base = issue.cvss_base
            row.cvss_inpeco = issue.cvss_inpeco
            row.discovered_in = issue.discovered_in
            row.fix_versions_json = json.dumps(issue.fix_versions, ensure_ascii=False)
            row.labels_json = json.dumps(issue.labels, ensure_ascii=False)
            row.components_json = json.dumps(issue.components, ensure_ascii=False)
            row.assignee = issue.assignee
            row.rejection_reason = issue.rejection_reason
            row.created = issue.created
            row.updated = issue.updated
            row.resolved = issue.resolved
            row.synced_at = now
        for row in existing.values():
            db.delete(row)
        db.commit()
        return CveSyncResult(created=created, updated=updated, removed=len(existing), total=len(issues))
    finally:
        _progress = None
        _sync_lock.release()
