from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db

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
    db.commit()
    db.refresh(row)
    return _to_public(row)
