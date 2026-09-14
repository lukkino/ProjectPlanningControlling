import datetime as dt

from app import models, schemas


def compute_dashboard_metrics(project: models.Project) -> schemas.DashboardMetrics:
    items = project.backlog_items
    in_scope_items = [i for i in items if i.in_scope]
    done_items = [i for i in in_scope_items if i.status == "Done"]

    backlog_total = len(items)
    backlog_in_scope = len(in_scope_items)
    backlog_done = len(done_items)

    # project.snapshots e' ordinato per snapshot_date crescente (vedi models.py),
    # quindi l'ultimo elemento e' la fotografia piu' recente.
    latest_snapshot = project.snapshots[-1] if project.snapshots else None
    completion_source = "backlog"
    last_snapshot_date = None
    if latest_snapshot is not None and latest_snapshot.pbi_total:
        backlog_in_scope = latest_snapshot.pbi_total
        backlog_done = latest_snapshot.pbi_done or 0
        completion_source = "snapshot"
        last_snapshot_date = latest_snapshot.snapshot_date

    percent_complete = (backlog_done / backlog_in_scope) if backlog_in_scope else 0.0

    budget_hours_total = sum(b.budget_hours for b in project.budget_lines) or project.estimated_budget_hours

    # "Ore usate" riflette lo sforzo reale sul progetto: preferiamo le ore
    # effettive dello snapshot (actual_hours) alle ore loggate, perche' queste
    # ultime possono essere solo un sottoinsieme rendicontato su Jira.
    logged_hours_source = "backlog"
    if latest_snapshot is not None and latest_snapshot.actual_hours is not None:
        logged_hours_total = latest_snapshot.actual_hours
        logged_hours_source = "snapshot"
    elif latest_snapshot is not None and latest_snapshot.logged_hours is not None:
        logged_hours_total = latest_snapshot.logged_hours
        logged_hours_source = "snapshot"
    else:
        logged_hours_total = sum(i.logged_hours or 0 for i in items)

    percent_budget_used = (logged_hours_total / budget_hours_total) if budget_hours_total else 0.0

    # Ore da Time Tracking Jira sui singoli item di backlog: e' un dato di
    # sola Development (il tempo che gli sviluppatori loggano sulle issue),
    # a differenza di logged_hours_total sopra che rappresenta lo sforzo
    # sull'intero progetto.
    dev_logged_hours_total = sum(i.logged_hours or 0 for i in items)

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
        dev_logged_hours_total=dev_logged_hours_total,
        percent_budget_used=percent_budget_used,
        percent_time_elapsed=percent_time_elapsed,
        spi=spi,
        completion_source=completion_source,
        logged_hours_source=logged_hours_source,
        last_snapshot_date=last_snapshot_date,
        phases=list(project.phases),
        budget_lines=list(project.budget_lines),
    )
