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
        logged_hours_total=logged_hours_total,
        dev_logged_hours_total=dev_logged_hours_total,
        percent_time_elapsed=percent_time_elapsed,
        spi=spi,
        completion_source=completion_source,
        logged_hours_source=logged_hours_source,
        last_snapshot_date=last_snapshot_date,
        phases=list(project.phases),
    )


def compute_increment_metrics(increment: models.Increment) -> schemas.IncrementDetail:
    """Il budget (ore totali/per ruolo + materiali) e' sempre proprio di
    questo progetto (vedi models.Increment), mai derivato. Backlog (PBI,
    % completamento) invece non e' suo: e' preso pari pari dal Project
    (rilascio) collegato, se assegnato - un progetto non ha un backlog Jira
    proprio.

    Le ore usate invece si dividono tra i progetti collegati allo stesso
    Project quando sono piu' di uno (es. principale + maintenance): Jira non
    sa quale progetto rendicontare, quindi si preferisce la somma delle ore
    Actual inserite a mano per ruolo; solo se nessuna e' ancora stata
    inserita si ricade sul totale Jira del Project collegato (comportamento
    corretto quando il progetto e' l'unico collegato a quel Project)."""
    project_metrics = compute_dashboard_metrics(increment.project) if increment.project else None

    budget_hours_total = sum(b.budget_hours for b in increment.budget_lines) or increment.estimated_budget_hours
    actual_hours_total = sum(b.actual_hours for b in increment.budget_lines)
    logged_hours_total = actual_hours_total or (project_metrics.logged_hours_total if project_metrics else 0.0)

    return schemas.IncrementDetail(
        id=increment.id,
        code=increment.code,
        notes=increment.notes,
        start_date=increment.start_date,
        end_date=increment.end_date,
        estimated_budget_hours=increment.estimated_budget_hours,
        estimated_budget_material=increment.estimated_budget_material,
        project_id=increment.project_id,
        created_at=increment.created_at,
        updated_at=increment.updated_at,
        project=increment.project,
        backlog_total=project_metrics.backlog_total if project_metrics else 0,
        backlog_in_scope=project_metrics.backlog_in_scope if project_metrics else 0,
        backlog_done=project_metrics.backlog_done if project_metrics else 0,
        percent_complete=project_metrics.percent_complete if project_metrics else 0.0,
        budget_hours_total=budget_hours_total,
        logged_hours_total=logged_hours_total,
        dev_logged_hours_total=project_metrics.dev_logged_hours_total if project_metrics else 0.0,
        percent_budget_used=(logged_hours_total / budget_hours_total) if budget_hours_total else 0.0,
        budget_lines=list(increment.budget_lines),
    )
