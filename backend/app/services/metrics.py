import datetime as dt

from sqlalchemy.orm import Session

from app import models, schemas
from app.routers.settings import SETTINGS_ROW_ID
from app.services.jira_client import JiraClientError, count_issues, count_issues_by_type

# Custom field Jira "Source Type" (dropdown): distingue i Bug segnalati da
# cliente (Complaint) da quelli trovati internamente. Il suffisso [Dropdown]
# nella JQL disambigua il campo, come confermato dall'utente.
BUG_COMPLAINT_JQL_CLAUSE = '"Source Type[Dropdown]" = Complaint'

# Tipi PBI mostrati nel grafico "Metriche" della Dashboard generale, nello
# stesso ordine della JQL standard di sync del backlog (Story, Bug, Activity).
PBI_TYPES_FOR_METRICS = ("Story", "Bug", "Activity")


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
    """Budget e Actual vivono entrambi nello Storico progetto (l'ultimo
    IncrementSnapshot, vedi models.py), mai sulla voce stessa - una
    revisione budget puo' cambiarli nel tempo come l'Actual. Backlog (PBI,
    % completamento) invece non e' suo: e' preso pari pari dal Project
    (rilascio) collegato, se assegnato - un progetto non ha un backlog Jira
    proprio.

    Le ore usate si dividono tra i progetti collegati allo stesso Project
    quando sono piu' di uno (es. principale + maintenance): Jira non sa
    quale progetto rendicontare, quindi si preferisce la somma dei valori
    Actual dell'ultimo snapshot sulle voci is_hours; solo se lo Storico e'
    ancora vuoto si ricade sul totale Jira del Project collegato
    (comportamento corretto quando il progetto e' l'unico collegato a quel
    Project)."""
    project_metrics = compute_dashboard_metrics(increment.project) if increment.project else None

    hours_lines = [b for b in increment.budget_lines if b.is_hours]
    material_lines = [b for b in increment.budget_lines if not b.is_hours]

    # increment.snapshots e' ordinato per snapshot_date crescente (vedi
    # models.py), quindi l'ultimo elemento e' la fotografia piu' recente.
    latest_snapshot = increment.snapshots[-1] if increment.snapshots else None
    latest_by_line = {v.budget_line_id: v for v in latest_snapshot.values} if latest_snapshot else {}

    budget_hours_total = sum(
        latest_by_line[b.id].budget_value for b in hours_lines if b.id in latest_by_line
    ) or increment.estimated_budget_hours
    budget_material_total = sum(
        latest_by_line[b.id].budget_value for b in material_lines if b.id in latest_by_line
    ) or increment.estimated_budget_material

    actual_hours_total = sum(latest_by_line[b.id].actual_value for b in hours_lines if b.id in latest_by_line)
    logged_hours_total = actual_hours_total if latest_snapshot else (
        project_metrics.logged_hours_total if project_metrics else 0.0
    )

    actual_material_total = sum(latest_by_line[b.id].actual_value for b in material_lines if b.id in latest_by_line)

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
        budget_material_total=budget_material_total,
        logged_hours_total=logged_hours_total,
        actual_material_total=actual_material_total,
        dev_logged_hours_total=project_metrics.dev_logged_hours_total if project_metrics else 0.0,
        percent_budget_used=(logged_hours_total / budget_hours_total) if budget_hours_total else 0.0,
        percent_material_used=(actual_material_total / budget_material_total) if budget_material_total else 0.0,
        budget_lines=list(increment.budget_lines),
        snapshots=list(increment.snapshots),
    )


def compute_overview_metrics(db: Session) -> schemas.OverviewMetrics:
    """Grafico a ciambella della Dashboard generale: quanti Story/Bug/Activity
    sono stati messi a Done negli ultimi 12 mesi, sull'INTERO progetto Jira
    configurato in Configurazione (jira_project_key) - non solo gli increment
    tracciati in questa app, il cui backlog locale e' un sottoinsieme filtrato
    per fixVersion. Interrogato live su Jira ad ogni caricamento: 'status
    CHANGED TO Done AFTER -365d' e' semanticamente la stessa richiesta che si
    farebbe a mano in Jira (issue transitate a Done nella finestra, anche se
    poi riaperte), a differenza di un filtro sullo stato attuale."""
    settings = db.get(models.AppSettings, SETTINGS_ROW_ID)
    project_key = (settings.jira_project_key if settings else None) or ""
    if not project_key.strip():
        return schemas.OverviewMetrics(
            done_last_12_months=[],
            done_last_12_months_total=0,
            error="Jira project key non configurata (sezione Configurazione).",
        )

    types_jql = ", ".join(PBI_TYPES_FOR_METRICS)
    jql = f"project = {project_key} AND issuetype in ({types_jql}) AND status CHANGED TO Done AFTER -365d"

    base_url = (settings.jira_base_url if settings else None) or ""
    email = (settings.jira_email if settings else None) or ""
    api_token = (settings.jira_api_token if settings else None) or ""

    try:
        raw_counts = count_issues_by_type(base_url, email, api_token, jql)
        complaint_jql = (
            f"project = {project_key} AND issuetype = Bug AND {BUG_COMPLAINT_JQL_CLAUSE} "
            "AND status CHANGED TO Done AFTER -365d"
        )
        bug_complaint_count = count_issues(base_url, email, api_token, complaint_jql)
    except JiraClientError as exc:
        return schemas.OverviewMetrics(done_last_12_months=[], done_last_12_months_total=0, error=str(exc))

    counts = {t: raw_counts.get(t, 0) for t in PBI_TYPES_FOR_METRICS}

    return schemas.OverviewMetrics(
        done_last_12_months=[schemas.PbiDoneCount(issue_type=t, count=c) for t, c in counts.items()],
        done_last_12_months_total=sum(counts.values()),
        bug_complaint_count=bug_complaint_count,
    )
