from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.document_generator import (
    generate_regression_analysis,
    generate_release_report,
    get_release_report_defaults,
)

router = APIRouter(tags=["documents"])


def _get_project_or_404(db: Session, project_id: int) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return project


def _xlsx_response(content: bytes, filename_stem: str) -> Response:
    filename = f"{filename_stem}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/projects/{project_id}/documents/regression-analysis")
def download_regression_analysis(project_id: int, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    content, filename_stem = generate_regression_analysis(project)
    return _xlsx_response(content, filename_stem)


@router.get("/api/projects/{project_id}/documents/release-report/meta", response_model=schemas.ReleaseReportMeta)
def release_report_meta(project_id: int, db: Session = Depends(get_db)):
    """Valori proposti (modificabili) per il form di generazione: prossima
    versione (ultima usata + 1) e testo di revisione (ultimo usato)."""
    project = _get_project_or_404(db, project_id)
    next_version, last_revision_text = get_release_report_defaults(project)
    return schemas.ReleaseReportMeta(next_version=next_version, last_revision_text=last_revision_text)


@router.get("/api/projects/{project_id}/documents/release-report")
def download_release_report(
    project_id: int,
    version: int | None = Query(None),
    revision_text: str | None = Query(None),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id)
    default_version, default_text = get_release_report_defaults(project)
    resolved_version = version if version is not None else default_version
    resolved_text = revision_text if revision_text is not None else default_text

    content, filename_stem = generate_release_report(project, resolved_version, resolved_text)

    # La versione/testo usati diventano il default proposto alla prossima
    # generazione (incrementale rispetto a questa).
    project.rr_last_version = resolved_version
    project.rr_last_revision_note = resolved_text
    db.commit()

    return _xlsx_response(content, filename_stem)
