import datetime as dt

from app import models, schemas


def compute_dashboard_metrics(project: models.Project) -> schemas.DashboardMetrics:
    items = project.backlog_items
    in_scope_items = [i for i in items if i.in_scope]
    done_items = [i for i in in_scope_items if i.status == "Done"]

    backlog_total = len(items)
    backlog_in_scope = len(in_scope_items)
    backlog_done = len(done_items)
    percent_complete = (backlog_done / backlog_in_scope) if backlog_in_scope else 0.0

    budget_hours_total = sum(b.budget_hours for b in project.budget_lines) or project.estimated_budget_hours
    logged_hours_total = sum(i.logged_hours or 0 for i in items)
    percent_budget_used = (logged_hours_total / budget_hours_total) if budget_hours_total else 0.0

    percent_time_elapsed = None
    spi = None
    if project.start_date and project.code_freeze_date:
        total_days = (project.code_freeze_date - project.start_date).days
        if total_days > 0:
            elapsed_days = (dt.date.today() - project.start_date).days
            percent_time_elapsed = max(0.0, min(elapsed_days / total_days, 2.0))
            if percent_time_elapsed > 0:
                spi = percent_complete / percent_time_elapsed

    return schemas.DashboardMetrics(
        backlog_total=backlog_total,
        backlog_in_scope=backlog_in_scope,
        backlog_done=backlog_done,
        percent_complete=percent_complete,
        budget_hours_total=budget_hours_total,
        logged_hours_total=logged_hours_total,
        percent_budget_used=percent_budget_used,
        percent_time_elapsed=percent_time_elapsed,
        spi=spi,
        phases=list(project.phases),
        budget_lines=list(project.budget_lines),
    )
