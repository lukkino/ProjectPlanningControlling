from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.jira_client import JiraClientError, test_connection

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Riga singola (vedi models.AppSettings): esiste sempre dopo la migrazione
# di seed, ma il fallback protegge comunque una install senza migrazioni
# ancora girate.
SETTINGS_ROW_ID = 1


def _get_or_create(db: Session) -> models.AppSettings:
    row = db.get(models.AppSettings, SETTINGS_ROW_ID)
    if row is None:
        row = models.AppSettings(id=SETTINGS_ROW_ID)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _to_public(row: models.AppSettings) -> schemas.AppSettingsPublic:
    token = row.jira_api_token
    preview = None
    if token:
        preview = f"••••{token[-4:]}" if len(token) > 4 else "••••"
    return schemas.AppSettingsPublic(
        jira_base_url=row.jira_base_url,
        jira_email=row.jira_email,
        jira_api_token_set=bool(token),
        jira_api_token_preview=preview,
        jira_api_token_expires_at=row.jira_api_token_expires_at,
        jira_project_key=row.jira_project_key,
    )


@router.get("", response_model=schemas.AppSettingsPublic)
def get_settings_row(db: Session = Depends(get_db)):
    return _to_public(_get_or_create(db))


@router.put("", response_model=schemas.AppSettingsPublic)
def update_settings_row(payload: schemas.AppSettingsUpdate, db: Session = Depends(get_db)):
    row = _get_or_create(db)
    data = payload.model_dump(exclude_unset=True)
    if "jira_base_url" in data:
        row.jira_base_url = data["jira_base_url"]
    if "jira_email" in data:
        row.jira_email = data["jira_email"]
    # Stringa vuota o assente: il token esistente resta invariato (vedi
    # schemas.AppSettingsUpdate).
    if data.get("jira_api_token"):
        row.jira_api_token = data["jira_api_token"]
    if "jira_api_token_expires_at" in data:
        row.jira_api_token_expires_at = data["jira_api_token_expires_at"]
    if "jira_project_key" in data:
        row.jira_project_key = data["jira_project_key"]
    db.commit()
    db.refresh(row)
    return _to_public(row)


@router.post("/test", response_model=schemas.TestConnectionResult)
def test_settings_connection(payload: schemas.AppSettingsUpdate, db: Session = Depends(get_db)):
    """Verifica le credenziali SENZA salvarle: usa i valori passati (es. dal
    form non ancora confermato) e ricade su quelli gia' salvati per i campi
    omessi, cosi' si puo' testare un nuovo token prima di premere Salva."""
    row = _get_or_create(db)
    base_url = payload.jira_base_url if payload.jira_base_url is not None else row.jira_base_url
    email = payload.jira_email if payload.jira_email is not None else row.jira_email
    api_token = payload.jira_api_token or row.jira_api_token
    try:
        display_name = test_connection(base_url or "", email or "", api_token or "")
    except JiraClientError as exc:
        return schemas.TestConnectionResult(ok=False, message=str(exc))
    return schemas.TestConnectionResult(ok=True, message=f"Connessione riuscita — autenticato come {display_name}")
