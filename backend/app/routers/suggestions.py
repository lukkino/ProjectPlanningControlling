"""Suggerimenti per i campi ancora vuoti di un utente (es. un PJM appena
creato): i valori dell'utente di riferimento, il primo Admin, che ha gia'
configurato l'app. Il frontend li mostra sotto i campi vuoti con "Usa"."""

import re

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db

router = APIRouter(tags=["suggestions"])

CODE_PLACEHOLDER = "{code}"


def _reference_user(db: Session) -> models.User | None:
    return db.query(models.User).filter(models.User.role == "admin").order_by(models.User.id).first()


def _increment_jql_template(db: Session, owner_id: int) -> str | None:
    """JQL dell'increment piu' recente (per codice) che contiene il proprio
    codice, col codice al posto di {code}: es.
    "project = PTBSYS and fixVersion = {code}"."""
    projects = (
        db.query(models.Project)
        .filter(models.Project.owner_id == owner_id, models.Project.jira_jql.isnot(None))
        .order_by(models.Project.code.desc())
    )
    for project in projects:
        jql = (project.jira_jql or "").strip()
        if not project.code:
            continue
        # Solo se la fixVersion e' esattamente il codice: con nomi come
        # "PTBSYS-03-005-March-27" il resto non vale per un altro increment.
        code = re.escape(project.code)
        pattern = re.compile(
            r'(fixversion\s*(?:=|in\s*\()\s*)(?:"' + code + r'"|' + code + r'(?=[\s),]|$))', re.IGNORECASE
        )
        m = pattern.search(jql)
        if m:
            quoted = m.group(0).endswith('"')
            replacement = m.group(1) + (f'"{CODE_PLACEHOLDER}"' if quoted else CODE_PLACEHOLDER)
            return jql[: m.start()] + replacement + jql[m.end() :]
    return None


@router.get("/api/suggestions", response_model=schemas.Suggestions)
def get_suggestions(db: Session = Depends(get_db)):
    reference = _reference_user(db)
    if reference is None:
        return schemas.Suggestions()
    settings = db.get(models.UserSettings, reference.id)
    return schemas.Suggestions(
        source=reference.display_name,
        team_sw_base_jql=settings.team_sw_base_jql if settings else None,
        team_embedded_base_jql=settings.team_embedded_base_jql if settings else None,
        complaints_base_jql=settings.complaints_base_jql if settings else None,
        increment_jql_template=_increment_jql_template(db, reference.id),
    )
