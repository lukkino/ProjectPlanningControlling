import json
import re

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services.design_input import EMPTY_COMPONENTS, DesignInputError, Story, add_stories
from app.services.document_generator import (
    PPR_DOCUMENT_TYPES,
    generate_ppr_document,
    generate_regression_analysis,
    generate_release_report,
    get_ppr_defaults,
    get_ppr_deliverables_defaults,
    get_regression_analysis_defaults,
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


def _resolve(
    version: int | None, revision_text: str | None, defaults: tuple[int, str]
) -> tuple[int, str]:
    default_version, default_text = defaults
    return (
        version if version is not None else default_version,
        revision_text if revision_text is not None else default_text,
    )


@router.get("/api/projects/{project_id}/documents/regression-analysis/meta", response_model=schemas.DocumentRevisionMeta)
def regression_analysis_meta(project_id: int, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    next_version, last_revision_text = get_regression_analysis_defaults(project)
    return schemas.DocumentRevisionMeta(next_version=next_version, last_revision_text=last_revision_text)


@router.get("/api/projects/{project_id}/documents/regression-analysis")
def download_regression_analysis(
    project_id: int,
    version: int | None = Query(None),
    revision_text: str | None = Query(None),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id)
    resolved_version, resolved_text = _resolve(version, revision_text, get_regression_analysis_defaults(project))
    content, filename_stem = generate_regression_analysis(project, resolved_version, resolved_text)
    return _xlsx_response(content, filename_stem)


@router.get("/api/projects/{project_id}/documents/release-report/meta", response_model=schemas.DocumentRevisionMeta)
def release_report_meta(project_id: int, db: Session = Depends(get_db)):
    """Valori proposti (modificabili) per il popup di generazione: prossima
    versione (ultima usata + 1) e testo di revisione (ultimo usato)."""
    project = _get_project_or_404(db, project_id)
    next_version, last_revision_text = get_release_report_defaults(project)
    return schemas.DocumentRevisionMeta(next_version=next_version, last_revision_text=last_revision_text)


@router.get("/api/projects/{project_id}/documents/release-report")
def download_release_report(
    project_id: int,
    version: int | None = Query(None),
    revision_text: str | None = Query(None),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id)
    resolved_version, resolved_text = _resolve(version, revision_text, get_release_report_defaults(project))

    content, filename_stem = generate_release_report(project, resolved_version, resolved_text)

    # La versione/testo usati diventano il default proposto alla prossima
    # generazione (incrementale rispetto a questa) - solo per la RR, che a
    # differenza di REA/PPR e' uno storico cumulativo di sistema.
    project.rr_last_version = resolved_version
    project.rr_last_revision_note = resolved_text
    db.commit()

    return _xlsx_response(content, filename_stem)


def _get_ppr_type_or_404(doc_type: str) -> None:
    if doc_type not in PPR_DOCUMENT_TYPES:
        raise HTTPException(status_code=404, detail=f"Tipo documento sconosciuto: {doc_type}")


@router.get("/api/projects/{project_id}/documents/ppr/{doc_type}/meta", response_model=schemas.PprDocumentMeta)
def ppr_meta(project_id: int, doc_type: str, db: Session = Depends(get_db)):
    _get_ppr_type_or_404(doc_type)
    project = _get_project_or_404(db, project_id)
    next_version, last_revision_text = get_ppr_defaults(project, doc_type)
    return schemas.PprDocumentMeta(
        next_version=next_version,
        last_revision_text=last_revision_text,
        deliverables=get_ppr_deliverables_defaults(),
    )


@router.get("/api/projects/{project_id}/documents/ppr/{doc_type}")
def download_ppr_document(
    project_id: int,
    doc_type: str,
    version: int | None = Query(None),
    revision_text: str | None = Query(None),
    deliverables: str | None = Query(None, description="Lista JSON di {row, included, filename, notes}"),
    db: Session = Depends(get_db),
):
    _get_ppr_type_or_404(doc_type)
    project = _get_project_or_404(db, project_id)
    resolved_version, resolved_text = _resolve(version, revision_text, get_ppr_defaults(project, doc_type))
    try:
        deliverables_list = json.loads(deliverables) if deliverables else None
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Parametro deliverables non valido") from exc
    content, filename_stem = generate_ppr_document(
        project, doc_type, resolved_version, resolved_text, deliverables_list
    )
    return _xlsx_response(content, filename_stem)


@router.post("/api/projects/{project_id}/documents/design-input")
def add_stories_to_design_input(
    project_id: int,
    filename: str = Query("TIH-DI-PTBSYS.xlsx"),
    workbook: bytes = Body(..., media_type="application/octet-stream"),
    db: Session = Depends(get_db),
):
    """Riceve il documento Design Input corrente (il file .xlsx cosi' com'e',
    nel corpo della richiesta) e lo restituisce con le Story in scope del
    backlog di questo increment aggiunte in cima al foglio "Design Input -
    Stories". Il file non viene salvato sul server."""
    project = _get_project_or_404(db, project_id)
    # Dalla piu' recente (numero di issue piu' alto), come nel documento.
    items = sorted(
        (i for i in project.backlog_items if i.in_scope and i.issue_type == "Story"),
        key=lambda i: int(i.jira_key.rsplit("-", 1)[-1]) if i.jira_key.rsplit("-", 1)[-1].isdigit() else 0,
        reverse=True,
    )
    stories = [
        Story(
            key=i.jira_key,
            title=i.summary or "",
            description=i.description or "",
            components=i.components or EMPTY_COMPONENTS,
            labels=", ".join(sorted(label for label in (i.labels or "").split(";") if label)),
        )
        for i in items
    ]
    try:
        content, added, skipped = add_stories(workbook, stories, notes=f"Increment {project.code}")
    except DesignInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    stem = re.sub(r"[^\w\-. ()+]", "_", filename.rsplit(".", 1)[0], flags=re.ASCII) or "TIH-DI-PTBSYS"
    response = _xlsx_response(content, f"{stem} - {project.code}")
    response.headers["X-Stories-Added"] = str(added)
    response.headers["X-Stories-Skipped"] = str(skipped)
    return response
