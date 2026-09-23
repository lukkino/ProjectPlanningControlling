import datetime as dt
import math

from sqlalchemy.orm import Session

from app import models, schemas
from app.routers.settings import SETTINGS_ROW_ID
from app.services.jira_client import (
    CVE_BUG_REPORTER_EMAIL,
    JiraClientError,
    count_issues,
    count_issues_by_type,
    fetch_created_and_status,
    fetch_cycle_times,
)

# Custom field Jira "Source Type" (dropdown): distingue i Bug segnalati da
# cliente (Complaint) da quelli trovati internamente. Il suffisso [Dropdown]
# nella JQL disambigua il campo, come confermato dall'utente.
BUG_COMPLAINT_JQL_CLAUSE = '"Source Type[Dropdown]" = Complaint'

# Stessa identificazione usata in jira_client.fetch_cycle_times per i punti
# del Cycle Time: qui serve come clausola JQL per contare i Bug CVE nel
# grafico Metriche.
CVE_BUG_JQL_CLAUSE = f'reporter = "{CVE_BUG_REPORTER_EMAIL}"'

# Custom field Jira "Enhancement" (dropdown): distingue le Story che sono
# miglioramenti (Enhancement = Yes) da quelle di sviluppo standard.
STORY_ENHANCEMENT_JQL_CLAUSE = '"Enhancement[Dropdown]" = Yes'

# Tipi PBI mostrati nel grafico "Metriche" della Dashboard generale, sempre
# in quest'ordine indipendentemente dal team - Task compare solo per il Team
# Embedded (la JQL base del Team SW non lo include mai), ma tenerlo fisso
# in entrambi i casi (0 se assente) mantiene colori/legenda stabili.
ALL_PBI_TYPES = ("Story", "Bug", "Activity", "Task")

TEAM_LABELS = {"sw": "Team SW", "embedded": "Team Embedded"}

# Finestre temporali del grafico "Metriche": ultimi 365 giorni e i 365
# giorni precedenti, entrambe relative a oggi (scorrono col tempo). Stessa
# semantica "CHANGED TO Done" in entrambe, cosi' i due anni sono confrontabili.
OVERVIEW_PERIOD_JQL = {
    "current": "status CHANGED TO Done AFTER -365d",
    "previous": "status CHANGED TO Done DURING (-730d, -365d)",
}


def _team_base_jql(settings: models.AppSettings | None, team: str) -> str:
    if team == "embedded":
        return (settings.team_embedded_base_jql if settings else None) or ""
    return (settings.team_sw_base_jql if settings else None) or ""


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


def compute_overview_metrics(db: Session, team: str = "sw", period: str = "current") -> schemas.OverviewMetrics:
    """Grafico a ciambella della Dashboard generale: quanti PBI sono stati
    messi a Done negli ultimi 12 mesi, sulla JQL base del team scelto
    (team_sw_base_jql o team_embedded_base_jql, configurate in
    Configurazione - gia' comprensive di project/issuetype/label) - non solo
    gli increment tracciati in questa app, il cui backlog locale e' un
    sottoinsieme filtrato per fixVersion. Interrogato live su Jira ad ogni
    caricamento: 'status CHANGED TO Done AFTER -365d' e' semanticamente la
    stessa richiesta che si farebbe a mano in Jira (issue transitate a Done
    nella finestra, anche se poi riaperte), a differenza di un filtro sullo
    stato attuale. Con period="previous" la finestra diventa l'anno prima
    ancora (da -730 a -365 giorni), per il confronto affiancato."""
    settings = db.get(models.AppSettings, SETTINGS_ROW_ID)
    base_jql = _team_base_jql(settings, team)
    window = OVERVIEW_PERIOD_JQL[period]
    if not base_jql.strip():
        return schemas.OverviewMetrics(
            done_last_12_months=[],
            done_last_12_months_total=0,
            error=f"JQL base del {TEAM_LABELS.get(team, team)} non configurata (sezione Configurazione).",
        )

    jql = f"{base_jql} AND {window}"

    base_url = (settings.jira_base_url if settings else None) or ""
    email = (settings.jira_email if settings else None) or ""
    api_token = (settings.jira_api_token if settings else None) or ""

    try:
        raw_counts = count_issues_by_type(base_url, email, api_token, jql)
        complaint_jql = f"{base_jql} AND issuetype = Bug AND {BUG_COMPLAINT_JQL_CLAUSE} AND {window}"
        bug_complaint_count = count_issues(base_url, email, api_token, complaint_jql)
        cve_jql = f"{base_jql} AND issuetype = Bug AND {CVE_BUG_JQL_CLAUSE} AND {window}"
        bug_cve_count = count_issues(base_url, email, api_token, cve_jql)
        enhancement_jql = (
            f"{base_jql} AND issuetype = Story AND {STORY_ENHANCEMENT_JQL_CLAUSE} AND {window}"
        )
        story_enhancement_count = count_issues(base_url, email, api_token, enhancement_jql)
    except JiraClientError as exc:
        return schemas.OverviewMetrics(done_last_12_months=[], done_last_12_months_total=0, error=str(exc))

    counts = {t: raw_counts.get(t, 0) for t in ALL_PBI_TYPES}

    return schemas.OverviewMetrics(
        done_last_12_months=[schemas.PbiDoneCount(issue_type=t, count=c) for t, c in counts.items()],
        done_last_12_months_total=sum(counts.values()),
        story_enhancement_count=story_enhancement_count,
        bug_complaint_count=bug_complaint_count,
        bug_cve_count=bug_cve_count,
    )


def _percentile(sorted_values: list[float], p: float) -> float | None:
    """Percentile con interpolazione lineare tra i due punti piu' vicini
    (stesso metodo di default di numpy.percentile), per non aggiungere
    numpy come dipendenza solo per questo."""
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return sorted_values[0]
    k = (len(sorted_values) - 1) * (p / 100)
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return sorted_values[int(k)]
    return sorted_values[f] * (c - k) + sorted_values[c] * (k - f)


def compute_cycle_time_metrics(db: Session, team: str = "sw") -> schemas.CycleTimeMetrics:
    """Scatterplot Cycle Time della Dashboard generale (e dati sorgente del
    Throughput, che li aggrega per mese lato frontend): un punto per PBI
    sulla JQL base del team scelto + finestra ultimi 12 mesi, asse Y il
    cycle time in giorni (actual_finish - actual_start, entrambi ricavati dal
    changelog Jira), con le linee di percentile 50/85/95."""
    settings = db.get(models.AppSettings, SETTINGS_ROW_ID)
    base_jql = _team_base_jql(settings, team)
    if not base_jql.strip():
        return schemas.CycleTimeMetrics(
            points=[], error=f"JQL base del {TEAM_LABELS.get(team, team)} non configurata (sezione Configurazione)."
        )

    jql = f"{base_jql} AND status CHANGED TO Done AFTER -365d"

    try:
        issues = fetch_cycle_times(
            (settings.jira_base_url if settings else None) or "",
            (settings.jira_email if settings else None) or "",
            (settings.jira_api_token if settings else None) or "",
            jql,
        )
    except JiraClientError as exc:
        return schemas.CycleTimeMetrics(points=[], error=str(exc))

    points = [
        schemas.CycleTimePoint(
            key=issue.key,
            issue_type=issue.issue_type,
            finish_date=issue.actual_finish,
            cycle_time_days=(issue.actual_finish - issue.actual_start).days,
            is_cve=issue.is_cve,
        )
        for issue in issues
        if issue.actual_start is not None and issue.actual_finish is not None
        and issue.actual_finish >= issue.actual_start
    ]
    points.sort(key=lambda p: p.finish_date)

    durations = sorted(p.cycle_time_days for p in points)
    return schemas.CycleTimeMetrics(
        points=points,
        p50=_percentile(durations, 50),
        p85=_percentile(durations, 85),
        p95=_percentile(durations, 95),
    )


def compute_bugs_opened_metrics(db: Session, team: str = "sw") -> schemas.BugsOpenedMetrics:
    """Andamento mese per mese dei Bug aperti (data di creazione) negli
    ultimi 12 mesi sulla JQL base del team scelto, divisi tra Complaint, non
    Complaint e CVE del bot di security scan (tenuti a parte perche' aperti
    in blocco a centinaia, schiaccerebbero il resto). Ricerche separate
    invece di leggere il campo "Source Type" per issue: la clausola JQL con
    [Dropdown] e' gia' quella verificata per la ciambella Metriche, mentre
    l'id del custom field non e' noto."""
    settings = db.get(models.AppSettings, SETTINGS_ROW_ID)
    base_jql = _team_base_jql(settings, team)
    if not base_jql.strip():
        return schemas.BugsOpenedMetrics(
            months=[], error=f"JQL base del {TEAM_LABELS.get(team, team)} non configurata (sezione Configurazione)."
        )

    base_url = (settings.jira_base_url if settings else None) or ""
    email = (settings.jira_email if settings else None) or ""
    api_token = (settings.jira_api_token if settings else None) or ""

    bugs_jql = f"{base_jql} AND issuetype = Bug AND created >= -365d"
    try:
        all_bugs = fetch_created_and_status(base_url, email, api_token, bugs_jql)
        complaint_keys = set(
            fetch_created_and_status(base_url, email, api_token, f"{bugs_jql} AND {BUG_COMPLAINT_JQL_CLAUSE}")
        )
        cve_keys = set(fetch_created_and_status(base_url, email, api_token, f"{bugs_jql} AND {CVE_BUG_JQL_CLAUSE}"))
    except JiraClientError as exc:
        return schemas.BugsOpenedMetrics(months=[], error=str(exc))

    # Tutti i mesi solari toccati dalla finestra di 365 giorni, dal mese di
    # oggi-365 a quello corrente (il primo e l'ultimo sono parziali).
    today = dt.date.today()
    cursor = (today - dt.timedelta(days=365)).replace(day=1)
    counts: dict[str, dict[str, int]] = {}
    while cursor <= today:
        counts[cursor.strftime("%Y-%m")] = {"complaint": 0, "non_complaint": 0, "cve": 0}
        cursor = (cursor + dt.timedelta(days=32)).replace(day=1)

    # Riepilogo per stato attuale degli stessi Bug del grafico, CVE esclusi
    # come nella linea del totale.
    status_counts: dict[str, int] = {}
    for key, (created, status) in all_bugs.items():
        bucket = counts.get(created.strftime("%Y-%m"))
        if bucket is None:
            continue
        if key in complaint_keys:
            bucket["complaint"] += 1
        elif key in cve_keys:
            bucket["cve"] += 1
            continue
        else:
            bucket["non_complaint"] += 1
        status_counts[status] = status_counts.get(status, 0) + 1

    return schemas.BugsOpenedMetrics(
        months=[schemas.BugsOpenedMonth(month=m, **c) for m, c in counts.items()],
        by_status=[
            schemas.BugStatusCount(status=st, count=c)
            for st, c in sorted(status_counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
    )
