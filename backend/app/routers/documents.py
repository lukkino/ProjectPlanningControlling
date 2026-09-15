from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app import models
from app.database import get_db
from app.services.document_generator import generate_regression_analysis

router = APIRouter(tags=["documents"])


@router.get("/api/projects/{project_id}/documents/regression-analysis")
def download_regression_analysis(project_id: int, db: Session = Depends(get_db)):
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")

    content, document_id = generate_regression_analysis(project)
    filename = f"{document_id}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
