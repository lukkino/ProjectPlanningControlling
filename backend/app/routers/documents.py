from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app import models
from app.database import get_db
from app.services.document_generator import generate_regression_analysis, generate_release_report

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


@router.get("/api/projects/{project_id}/documents/release-report")
def download_release_report(project_id: int, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    content, filename_stem = generate_release_report(project)
    return _xlsx_response(content, filename_stem)
