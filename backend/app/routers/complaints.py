import datetime as dt
import json
import re
import subprocess
import sys
from collections.abc import Callable
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.ownership import scope_user_id, user_settings, user_settings_for_update
from app.routers import change_order
from app.routers.settings import SETTINGS_ROW_ID
from app.services.db_backup import DatabaseBackupError, backup_database
from app.services.jira_client import JiraClientError, fetch_complaints, test_connection

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

JIRA_BROWSE_URL = "https://inpeco.atlassian.net/browse/"

# Avanzamento della sync in corso (una sola alla volta: i complaint non
# dipendono dal progetto), letto dal popup del frontend mentre la POST di
# sync e' in attesa. Come per il Backlog, in memoria basta.
_sync_progress: schemas.SyncProgress | None = None

# Colonne dell'export Excel: le stesse della tabella della pagina, nello
# stesso ordine (intestazione, larghezza della colonna).
EXPORT_COLUMNS = [
    ("ID Salesforce", 15),
    ("Summary", 80),
    ("Stato Salesforce", 18),
    ("ID Jira", 15),
    ("Stato Jira", 15),
    ("Fix Version", 28),
    ("TSB", 15),
    ("TSB Status", 15),
    ("Severity", 12),
    ("Creato su Jira", 16),
    ("Architettura", 15),
    ("Sito Cliente", 28),
    ("Inpeco Priority", 15),
    ("Customer Impact", 15),
    ("Safety", 10),
    ("Severity SF", 24),
]

# Il numero del case Salesforce e' anche in testa al summary ("[76665]...").
_SUMMARY_CASE_RE = re.compile(r"^\s*\[(\d+)\]")

# Lettura dei Case da Salesforce dopo la sync Jira (vedi
# services/tools/salesforce_cases.py): login e query di solito in 10-20 s.
SALESFORCE_TIMEOUT_S = 150


def _salesforce_case_numbers(value: str | None) -> list[str]:
    """Numeri di case Salesforce a 8 cifre dal campo "ID Salesforce" (come
    salesforceCaseNumbers nel frontend): in Jira spesso mancano gli zeri
    davanti; i ticket del vecchio sistema AX ("AX 034877", numeri a 6 cifre
    con lo zero davanti) non sono in Salesforce; in "AX 032314, SF: 50889"
    vale solo SF."""
    if not value:
        return []
    sf_part = re.search(r"SF\s*:\s*(.*)$", value, re.IGNORECASE)
    text = sf_part.group(1) if sf_part else re.sub(r"AX\s*\d+", "", value, flags=re.IGNORECASE)
    return [
        n.zfill(8)
        for n in re.findall(r"\d+", text)
        if len(n) <= 8 and not (len(n) == 6 and n.startswith("0"))
    ]


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


def _base_jql(db: Session) -> str:
    """JQL dei complaints dell'utente (vuota per un utente nuovo: va impostata)."""
    return (user_settings(db).complaints_base_jql or "").strip()


def _owned(db: Session):
    return db.query(models.Complaint).filter(models.Complaint.owner_id == scope_user_id())


@router.get("", response_model=list[schemas.Complaint])
def list_complaints(db: Session = Depends(get_db)):
    return (
        _owned(db)
        .order_by(models.Complaint.jira_created.desc(), models.Complaint.jira_key.desc())
        .all()
    )


# Dichiarate prima di "/{complaint_id}": altrimenti "settings", "export" e
# "sync" verrebbero lette come id.
@router.get("/settings", response_model=schemas.ComplaintsSettings)
def get_complaints_settings(db: Session = Depends(get_db)):
    return schemas.ComplaintsSettings(base_jql=_base_jql(db))


@router.get("/export")
def export_complaints(db: Session = Depends(get_db)):
    """Tutti i complaint in un foglio Excel (indipendentemente dai filtri
    attivi nella pagina), dal piu' nuovo, con le intestazioni filtrabili."""
    complaints = (
        _owned(db)
        .order_by(models.Complaint.jira_created.desc(), models.Complaint.jira_key.desc())
        .all()
    )
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Complaints"
    sheet.append([header for header, _ in EXPORT_COLUMNS])
    for c in complaints:
        sheet.append(
            [
                c.salesforce_case_number,
                c.summary,
                c.sf_status or c.salesforce_status,
                c.jira_key,
                c.jira_status,
                c.fix_versions,
                ", ".join(a["key"] for a in json.loads(c.tsb_activities or "[]")),
                ", ".join(a.get("status") or "-" for a in json.loads(c.tsb_activities or "[]")),
                c.severity,
                c.jira_created,
                c.architecture,
                c.customer_site,
                c.sf_inpeco_priority,
                c.sf_customer_impact,
                c.sf_safety,
                c.sf_severity,
            ]
        )

    for index, (_, width) in enumerate(EXPORT_COLUMNS, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width
        header = sheet.cell(row=1, column=index)
        header.font = Font(bold=True, color="FFFFFF")
        header.fill = PatternFill("solid", fgColor="2F6FED")
        header.alignment = Alignment(vertical="center")
    for row in sheet.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=cell.column == 2)
        key = row[3]
        key.hyperlink = f"{JIRA_BROWSE_URL}{key.value}"
        key.font = Font(color="0563C1", underline="single")
        # TSB: link alla prima activity (una cella ha un solo link).
        tsb = row[6]
        if tsb.value:
            tsb.hyperlink = f"{JIRA_BROWSE_URL}{tsb.value.split(', ')[0]}"
            tsb.font = Font(color="0563C1", underline="single")
        row[9].number_format = "DD/MM/YYYY"
    # Filtro automatico su tutte le colonne, con l'intestazione bloccata in
    # alto scorrendo le righe.
    sheet.auto_filter.ref = sheet.dimensions
    sheet.freeze_panes = "A2"

    buffer = BytesIO()
    workbook.save(buffer)
    filename = f"Complaints {dt.datetime.now():%Y-%m-%d %H%M}.xlsx"
    return Response(
        content=buffer.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.put("/settings", response_model=schemas.ComplaintsSettings)
def update_complaints_settings(payload: schemas.ComplaintsSettings, db: Session = Depends(get_db)):
    row = user_settings_for_update(db)
    row.complaints_base_jql = payload.base_jql.strip() or None
    db.commit()
    return schemas.ComplaintsSettings(base_jql=_base_jql(db))


@router.get("/sync/progress", response_model=schemas.SyncProgress)
def get_sync_progress():
    return _sync_progress or schemas.SyncProgress(phase="idle")


@router.post("/sync", response_model=schemas.SyncResult)
def sync_complaints_from_jira(db: Session = Depends(get_db)):
    global _sync_progress

    def on_progress(phase: str, done: int, total: int) -> None:
        global _sync_progress
        _sync_progress = schemas.SyncProgress(phase=phase, done=done, total=total)

    try:
        return _sync_complaints(db, on_progress)
    finally:
        _sync_progress = None


def _sync_complaints(db: Session, on_progress: Callable[[str, int, int], None]) -> schemas.SyncResult:
    row = _settings_row(db)
    try:
        base_url = (row.jira_base_url if row else None) or ""
        email = (row.jira_email if row else None) or ""
        api_token = (row.jira_api_token if row else None) or ""
        # Credenziali prima di tutto: vedi la sync del Backlog.
        test_connection(base_url, email, api_token)
        base_jql = _base_jql(db)
        if not base_jql:
            raise HTTPException(
                status_code=400,
                detail="Imposta prima la JQL dei complaints (pulsante JQL in questa pagina): senza non c'è niente da sincronizzare.",
            )
        issues = fetch_complaints(base_url, email, api_token, base_jql, on_progress)
    except JiraClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    on_progress("saving", len(issues), len(issues))

    # Una JQL sbagliata (o troppo stretta) che non trova nulla svuoterebbe la
    # tabella, perdendo gli stati Salesforce e i siti inseriti a mano: in quel
    # caso non si tocca niente.
    if not issues:
        raise HTTPException(
            status_code=400,
            detail="La JQL non ha restituito nessuna issue: sincronizzazione annullata, i complaint esistenti non sono stati modificati.",
        )
    try:
        backup_database("sync-complaints")
    except DatabaseBackupError as exc:
        raise HTTPException(status_code=500, detail=f"{exc}. Sincronizzazione annullata.") from exc

    owner_id = scope_user_id()
    existing = {c.jira_key: c for c in _owned(db)}
    matched_keys = {issue.key for issue in issues}
    now = dt.datetime.utcnow()
    created = 0
    updated = 0

    for issue in issues:
        complaint = existing.get(issue.key)
        if complaint is None:
            # salesforce_status resta al default ("Aperto"): non e' in Jira.
            complaint = models.Complaint(jira_key=issue.key, owner_id=owner_id)
            db.add(complaint)
            created += 1
        else:
            updated += 1
        complaint.summary = issue.summary
        complaint.jira_status = issue.status
        complaint.fix_versions = ", ".join(issue.fix_versions) or None
        complaint.severity = issue.severity
        complaint.jira_created = issue.created
        complaint.jira_resolved = issue.resolved
        complaint.labels = ";".join(issue.labels)
        if not complaint.architecture_manual:
            complaint.architecture = _architecture(issue.labels)
        complaint.salesforce_case_number = _case_number(issue.source_note, issue.summary)
        complaint.salesforce_case_id = issue.salesforce_case_id
        complaint.tsb_activities = json.dumps(issue.tsb_activities) if issue.tsb_activities else None
        if not complaint.customer_site_manual:
            complaint.customer_site = complaint.sf_account or _customer_site(issue.labels)
        complaint.last_synced_at = now

    # Come per il Backlog: cio' che non e' piu' nel risultato della JQL (es.
    # Source Type cambiato su Jira) viene rimosso.
    removed = 0
    for jira_key, complaint in existing.items():
        if jira_key not in matched_keys:
            db.delete(complaint)
            removed += 1

    db.commit()

    # Poi Salesforce: un errore qui non annulla la sync Jira, diventa un
    # avviso nel risultato.
    on_progress("salesforce", 0, 0)
    errors: list[str] = []
    try:
        salesforce_matched = _read_salesforce(db, list(_owned(db)))
    except HTTPException as exc:
        salesforce_matched = None
        errors.append(f"Salesforce non letto: {exc.detail}")
    return schemas.SyncResult(
        created=created,
        updated=updated,
        removed=removed,
        total_matched=len(issues),
        errors=errors,
        salesforce_matched=salesforce_matched,
    )


def _read_salesforce(db: Session, complaints: list[models.Complaint]) -> int:
    """Legge i Case dei complaint da Salesforce (processo separato, col
    profilo del browser del CO) e ne salva Status, cliente, priorita' e
    impatto. Il Case di un complaint si cerca per id del record (dal campo
    Jira), poi per numero del case, poi per chiave Jira (campo JiraID del
    Case). Restituisce quanti complaint hanno trovato il loro Case."""
    if not complaints:
        return 0
    if change_order._running():
        raise HTTPException(status_code=409, detail="è aperta la finestra del Change Order: chiudila e rifai la sync.")
    if not change_order._status_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="il browser dell'app è occupato da un'altra lettura.")
    numbers_of = {c.id: _salesforce_case_numbers(c.salesforce_case_number) for c in complaints}
    request = {
        "ids": [c.salesforce_case_id for c in complaints if c.salesforce_case_id],
        "jira_keys": [c.jira_key for c in complaints],
        "case_numbers": [n for numbers in numbers_of.values() for n in numbers],
    }
    try:
        result = subprocess.run(
            [sys.executable, "-m", "app.services.tools.salesforce_cases"],
            cwd=change_order.BACKEND_DIR,
            input=json.dumps(request),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=SALESFORCE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Salesforce non ha risposto in tempo.")
    finally:
        change_order._status_lock.release()
    lines = [line for line in result.stdout.splitlines() if line.strip().startswith("{")]
    outcome = json.loads(lines[-1]) if lines else {"records": [], "error": "nessuna risposta dalla lettura"}
    if outcome.get("error") == "login":
        raise HTTPException(
            status_code=409,
            detail='login non riuscito: apri il CO una volta con "Imposta impatto Software" e rifai il login Microsoft.',
        )
    if outcome.get("error"):
        raise HTTPException(status_code=502, detail=outcome["error"])

    records = outcome["records"]
    by_id = {r["id"]: r for r in records}
    by_number = {r["case_number"]: r for r in records if r.get("case_number")}
    by_jira: dict[str, list[dict]] = {}
    for r in records:
        if r.get("jira_key"):
            by_jira.setdefault(r["jira_key"].strip(), []).append(r)
    now = dt.datetime.utcnow()
    matched = 0
    for c in complaints:
        record = by_id.get(c.salesforce_case_id or "")
        if record is None:
            record = next((by_number[n] for n in numbers_of[c.id] if n in by_number), None)
        if record is None:
            # Piu' Case sulla stessa chiave Jira: prima quelli aperti.
            candidates = sorted(by_jira.get(c.jira_key, []), key=lambda r: bool(r.get("is_closed")))
            record = candidates[0] if candidates else None
        if record is None:
            c.sf_record_id = c.sf_status = c.sf_account = None
            c.sf_inpeco_priority = c.sf_customer_impact = c.sf_safety = c.sf_severity = None
            continue
        matched += 1
        c.sf_record_id = record["id"]
        c.sf_status = record.get("status")
        c.sf_account = record.get("account")
        c.sf_inpeco_priority = record.get("inpeco_priority")
        c.sf_customer_impact = record.get("customer_impact")
        c.sf_safety = record.get("safety")
        c.sf_severity = record.get("severity")
        c.sf_synced_at = now
        # Lo stato Aperto/Chiuso (filtri, KPI, export) segue Salesforce.
        if record.get("is_closed") is not None:
            c.salesforce_status = "Chiuso" if record["is_closed"] else "Aperto"
        if not c.customer_site_manual and c.sf_account:
            c.customer_site = c.sf_account
    db.commit()
    return matched


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
