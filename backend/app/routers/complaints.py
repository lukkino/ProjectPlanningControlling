import datetime as dt
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.routers.settings import SETTINGS_ROW_ID
from app.services.jira_client import JiraClientError, fetch_complaints

router = APIRouter(prefix="/api/complaints", tags=["complaints"])

# Architettura e Sito Cliente non hanno un campo Jira dedicato: sono label
# dell'issue. L'architettura e' una di queste quattro (stesso elenco di
# schemas.ComplaintUpdate.architecture); se la label manca o e' sbagliata si
# imposta a mano dalla pagina (vedi Complaint.architecture_manual).
ARCHITECTURES = ["Legacy", "NA5", "NA6", "NA7"]

# Il Sito Cliente e' una label "libera" (es. "Careggi", "Policlinico_Milano"),
# mescolata alle label di lavorazione: si considerano sito le label che
# iniziano con una maiuscola, non contengono cifre (via release come
# "PTBSYS-02-017", "CAPA30"...) e non sono in questo elenco di label note
# che non sono siti. Dove il risultato e' sbagliato il sito si corregge a
# mano dalla pagina (vedi Complaint.customer_site_manual).
NON_SITE_LABELS = {
    "Analysis",
    "Analytix",
    "Board_Redesign",
    "DAS",
    "Development",
    "HP",
    "IPTB",
    "PDP",
    "PTB-Maintenance",
    "PTB_Master_HW&SW",
    "Postpone-Checkout",
    "Postponed",
    "TSB",
    "Transportation",
}

# Il numero del case Salesforce e' anche in testa al summary ("[76665]...").
_SUMMARY_CASE_RE = re.compile(r"^\s*\[(\d+)\]")


def _architecture(labels: list[str]) -> str | None:
    return ", ".join(a for a in ARCHITECTURES if a in labels) or None


def _customer_site(labels: list[str]) -> str | None:
    sites = [
        label.replace("_", " ")
        for label in labels
        if label not in ARCHITECTURES
        and label not in NON_SITE_LABELS
        and label[:1].isupper()
        and not any(ch.isdigit() for ch in label)
    ]
    return ", ".join(sites) or None


def _case_number(source_note: str | None, summary: str) -> str | None:
    if source_note and source_note.strip():
        return source_note.strip()
    match = _SUMMARY_CASE_RE.match(summary or "")
    return match.group(1) if match else None


def _settings_row(db: Session) -> models.AppSettings | None:
    return db.get(models.AppSettings, SETTINGS_ROW_ID)


def _base_jql(row: models.AppSettings | None) -> str:
    return (row.complaints_base_jql if row else None) or models.DEFAULT_COMPLAINTS_JQL


@router.get("", response_model=list[schemas.Complaint])
def list_complaints(db: Session = Depends(get_db)):
    return (
        db.query(models.Complaint)
        .order_by(models.Complaint.jira_created.desc(), models.Complaint.jira_key.desc())
        .all()
    )


# Dichiarate prima di "/{complaint_id}": altrimenti "settings" e "sync"
# verrebbero lette come id.
@router.get("/settings", response_model=schemas.ComplaintsSettings)
def get_complaints_settings(db: Session = Depends(get_db)):
    return schemas.ComplaintsSettings(base_jql=_base_jql(_settings_row(db)))


@router.put("/settings", response_model=schemas.ComplaintsSettings)
def update_complaints_settings(payload: schemas.ComplaintsSettings, db: Session = Depends(get_db)):
    row = _settings_row(db)
    if row is None:
        row = models.AppSettings(id=SETTINGS_ROW_ID)
        db.add(row)
    # Vuota = si torna alla JQL di default.
    row.complaints_base_jql = payload.base_jql.strip() or None
    db.commit()
    return schemas.ComplaintsSettings(base_jql=_base_jql(row))


@router.post("/sync", response_model=schemas.SyncResult)
def sync_complaints_from_jira(db: Session = Depends(get_db)):
    row = _settings_row(db)
    try:
        issues = fetch_complaints(
            (row.jira_base_url if row else None) or "",
            (row.jira_email if row else None) or "",
            (row.jira_api_token if row else None) or "",
            _base_jql(row),
        )
    except JiraClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Una JQL sbagliata (o troppo stretta) che non trova nulla svuoterebbe la
    # tabella, perdendo gli stati Salesforce e i siti inseriti a mano: in quel
    # caso non si tocca niente.
    if not issues:
        raise HTTPException(
            status_code=400,
            detail="La JQL non ha restituito nessuna issue: sincronizzazione annullata, i complaint esistenti non sono stati modificati.",
        )

    existing = {c.jira_key: c for c in db.query(models.Complaint)}
    matched_keys = {issue.key for issue in issues}
    now = dt.datetime.utcnow()
    created = 0
    updated = 0

    for issue in issues:
        complaint = existing.get(issue.key)
        if complaint is None:
            # salesforce_status resta al default ("Aperto"): non e' in Jira.
            complaint = models.Complaint(jira_key=issue.key)
            db.add(complaint)
            created += 1
        else:
            updated += 1
        complaint.summary = issue.summary
        complaint.jira_status = issue.status
        complaint.severity = issue.severity
        complaint.jira_created = issue.created
        complaint.jira_resolved = issue.resolved
        complaint.labels = ";".join(issue.labels)
        if not complaint.architecture_manual:
            complaint.architecture = _architecture(issue.labels)
        complaint.salesforce_case_number = _case_number(issue.source_note, issue.summary)
        complaint.salesforce_case_id = issue.salesforce_case_id
        if not complaint.customer_site_manual:
            complaint.customer_site = _customer_site(issue.labels)
        complaint.last_synced_at = now

    # Come per il Backlog: cio' che non e' piu' nel risultato della JQL (es.
    # Source Type cambiato su Jira) viene rimosso.
    removed = 0
    for jira_key, complaint in existing.items():
        if jira_key not in matched_keys:
            db.delete(complaint)
            removed += 1

    db.commit()
    return schemas.SyncResult(created=created, updated=updated, removed=removed, total_matched=len(issues))


@router.put("/{complaint_id}", response_model=schemas.Complaint)
def update_complaint(complaint_id: int, payload: schemas.ComplaintUpdate, db: Session = Depends(get_db)):
    complaint = db.get(models.Complaint, complaint_id)
    if complaint is None:
        raise HTTPException(status_code=404, detail="Complaint non trovato")
    data = payload.model_dump(exclude_unset=True)
    if data.get("salesforce_status"):
        complaint.salesforce_status = data["salesforce_status"]
    labels = (complaint.labels or "").split(";")
    if "architecture" in data:
        architecture = data["architecture"] or None
        complaint.architecture_manual = architecture is not None
        complaint.architecture = architecture or _architecture(labels)
    if "customer_site" in data:
        site = (data["customer_site"] or "").strip()
        complaint.customer_site_manual = bool(site)
        complaint.customer_site = site or _customer_site(labels)
    db.commit()
    db.refresh(complaint)
    return complaint
