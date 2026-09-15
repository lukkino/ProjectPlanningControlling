import datetime as dt
import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.config import get_settings
from app.database import get_db
from app.services.jira_client import JiraClientError, search_issues

router = APIRouter(tags=["backlog"])


def _get_project_or_404(db: Session, project_id: int) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return project


def _get_item_or_404(db: Session, item_id: int) -> models.BacklogItem:
    item = db.get(models.BacklogItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Backlog item non trovato")
    return item


@router.get("/api/projects/{project_id}/backlog", response_model=list[schemas.BacklogItem])
def list_backlog(project_id: int, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    return (
        db.query(models.BacklogItem)
        .filter(models.BacklogItem.project_id == project_id)
        .order_by(models.BacklogItem.priority_order)
        .all()
    )


@router.post("/api/projects/{project_id}/backlog", response_model=schemas.BacklogItem, status_code=201)
def create_backlog_item(project_id: int, payload: schemas.BacklogItemCreate, db: Session = Depends(get_db)):
    _get_project_or_404(db, project_id)
    item = models.BacklogItem(project_id=project_id, **payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/api/backlog/{item_id}", response_model=schemas.BacklogItem)
def update_backlog_item(item_id: int, payload: schemas.BacklogItemUpdate, db: Session = Depends(get_db)):
    item = _get_item_or_404(db, item_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/api/backlog/{item_id}", status_code=204)
def delete_backlog_item(item_id: int, db: Session = Depends(get_db)):
    item = _get_item_or_404(db, item_id)
    db.delete(item)
    db.commit()


@router.post("/api/projects/{project_id}/backlog/sync", response_model=schemas.SyncResult)
def sync_backlog_from_jira(project_id: int, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    if not project.jira_jql:
        raise HTTPException(status_code=400, detail="Il progetto non ha una JQL configurata")

    settings = get_settings()
    try:
        issues = search_issues(settings, project.jira_jql)
    except JiraClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    existing = {
        item.jira_key: item
        for item in db.query(models.BacklogItem).filter(models.BacklogItem.project_id == project_id)
    }

    created = 0
    updated = 0
    now = dt.datetime.utcnow()
    max_order = max((item.priority_order for item in existing.values()), default=0)

    for issue in issues:
        labels = ";".join(issue.labels)
        implemented_by_json = json.dumps(issue.implemented_by) if issue.implemented_by else None
        if issue.key in existing:
            item = existing[issue.key]
            item.summary = issue.summary
            item.issue_type = issue.issue_type
            item.jira_status = issue.status
            item.labels = labels
            item.parent_key = issue.parent_key
            item.parent_summary = issue.parent_summary
            item.implemented_by_json = implemented_by_json
            item.logged_hours = issue.logged_hours
            item.actual_start = issue.actual_start
            item.actual_finish = issue.actual_finish
            item.last_synced_at = now
            updated += 1
        else:
            max_order += 1
            item = models.BacklogItem(
                project_id=project_id,
                jira_key=issue.key,
                priority_order=max_order,
                summary=issue.summary,
                issue_type=issue.issue_type,
                jira_status=issue.status,
                labels=labels,
                parent_key=issue.parent_key,
                parent_summary=issue.parent_summary,
                implemented_by_json=implemented_by_json,
                logged_hours=issue.logged_hours,
                actual_start=issue.actual_start,
                actual_finish=issue.actual_finish,
                last_synced_at=now,
            )
            db.add(item)
            created += 1

    db.commit()
    return schemas.SyncResult(created=created, updated=updated, total_matched=len(issues))
