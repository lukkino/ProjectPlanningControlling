import datetime as dt
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


# ---------- Phase ----------

class PhaseBase(BaseModel):
    name: str
    planned_date: dt.date | None = None
    actual_date: dt.date | None = None
    order: int = 0
    notes: str | None = None


class PhaseCreate(PhaseBase):
    pass


class PhaseUpdate(BaseModel):
    name: str | None = None
    planned_date: dt.date | None = None
    actual_date: dt.date | None = None
    order: int | None = None
    notes: str | None = None


class Phase(PhaseBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    project_id: int


# ---------- IncrementBudgetLine ----------

class IncrementBudgetLineBase(BaseModel):
    category_name: str
    is_hours: bool = False
    order: int = 0


class IncrementBudgetLineCreate(IncrementBudgetLineBase):
    pass


class IncrementBudgetLineUpdate(BaseModel):
    category_name: str | None = None
    is_hours: bool | None = None
    order: int | None = None


class IncrementBudgetLine(IncrementBudgetLineBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    increment_id: int


# ---------- IncrementSnapshot (Storico progetto) ----------

class IncrementSnapshotValue(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    budget_line_id: int
    budget_value: float
    actual_value: float


class IncrementSnapshotValueUpdate(BaseModel):
    budget_value: float | None = None
    actual_value: float | None = None


class IncrementSnapshotSubValue(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    sub_project_id: int
    actual_hours: float


class IncrementSnapshotSubValueUpdate(BaseModel):
    actual_hours: float = Field(ge=0)


class IncrementSnapshotBase(BaseModel):
    snapshot_date: dt.date
    note: str | None = None


class IncrementSnapshotCreate(IncrementSnapshotBase):
    pass


class IncrementSnapshotUpdate(BaseModel):
    snapshot_date: dt.date | None = None
    note: str | None = None


class IncrementSnapshot(IncrementSnapshotBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    increment_id: int
    values: list[IncrementSnapshotValue] = []
    # Actual ore dei sotto-progetti del progetto: solo quelli gia' inseriti.
    sub_values: list[IncrementSnapshotSubValue] = []


# ---------- Calcolatore ore progetto ----------

class IncrementResourceTypeBase(BaseModel):
    name: str
    resource_count: float = Field(default=1, ge=0)
    hours_per_day: float = Field(default=8, ge=0, le=24)
    order: int = 0


class IncrementResourceTypeCreate(IncrementResourceTypeBase):
    pass


class IncrementResourceTypeUpdate(BaseModel):
    name: str | None = None
    resource_count: float | None = Field(default=None, ge=0)
    hours_per_day: float | None = Field(default=None, ge=0, le=24)
    order: int | None = None


class IncrementResourceType(IncrementResourceTypeBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    increment_id: int


class HoursCalculatorUpdate(BaseModel):
    start_date: dt.date | None = None
    end_date: dt.date | None = None
    vacation_days: float | None = Field(default=None, ge=0)


class HoursCalculator(BaseModel):
    """start_date/end_date null = non impostate: la UI usa le date del
    progetto."""

    start_date: dt.date | None = None
    end_date: dt.date | None = None
    vacation_days: float = 0
    resource_types: list[IncrementResourceType] = []


# ---------- BacklogItem ----------

class BacklogItemBase(BaseModel):
    jira_key: str
    priority_order: float = 0
    ready_for_refinement: bool = False
    in_scope: bool = True
    included_in_codefreeze: bool = True
    planned: bool = False
    planned_duration_days: float | None = None
    dev_estimate_hours: float | None = None
    test_estimate_hours: float | None = None
    planned_hours: float | None = None
    planned_start: dt.date | None = None
    expected_finish: dt.date | None = None
    actual_start: dt.date | None = None
    actual_finish: dt.date | None = None
    logged_hours: float | None = None
    refinement_date: str | None = None
    ta_date: str | None = None
    notes: str | None = None
    progetto_id: int | None = None


class BacklogItemCreate(BacklogItemBase):
    pass


class BacklogItemUpdate(BaseModel):
    priority_order: float | None = None
    ready_for_refinement: bool | None = None
    in_scope: bool | None = None
    included_in_codefreeze: bool | None = None
    planned: bool | None = None
    planned_duration_days: float | None = None
    dev_estimate_hours: float | None = None
    test_estimate_hours: float | None = None
    planned_hours: float | None = None
    planned_start: dt.date | None = None
    expected_finish: dt.date | None = None
    actual_start: dt.date | None = None
    actual_finish: dt.date | None = None
    logged_hours: float | None = None
    refinement_date: str | None = None
    ta_date: str | None = None
    notes: str | None = None
    progetto_id: int | None = None


class BacklogItemBulkUpdate(BacklogItemUpdate):
    id: int


class BacklogItem(BacklogItemBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    project_id: int
    summary: str | None = None
    description: str | None = None
    change_description: str | None = None
    problem_cause: str | None = None
    components: str | None = None
    dev_effort_hours: float | None = None
    issue_type: str | None = None
    jira_status: str | None = None
    labels: str | None = None
    parent_key: str | None = None
    parent_summary: str | None = None
    implemented_by_json: str | None = None
    last_synced_at: dt.datetime | None = None
    status: str


class SyncResult(BaseModel):
    created: int
    updated: int
    removed: int = 0
    total_matched: int
    errors: list[str] = []


# ---------- Snapshot ----------

class SnapshotBase(BaseModel):
    snapshot_date: dt.date
    actual_hours: float | None = None
    logged_hours: float | None = None
    pbi_total: int | None = None
    pbi_done: int | None = None
    note: str | None = None


class SnapshotCreate(SnapshotBase):
    pass


class SnapshotUpdate(BaseModel):
    snapshot_date: dt.date | None = None
    actual_hours: float | None = None
    logged_hours: float | None = None
    pbi_total: int | None = None
    pbi_done: int | None = None
    note: str | None = None


# ---------- ForecastSimulation ----------

class ForecastSimulationBase(BaseModel):
    note: str | None = None
    simulation_date: dt.date | None = None
    pbi_remaining: int | None = None
    pbi_done: int | None = None
    planned_pbi_done: int | None = None
    unplanned_pbi_done: int | None = None
    planned_pbi_keys: str | None = None
    unplanned_pbi_keys: str | None = None
    traditional_forecasting: str | None = None
    code_freeze_deadline: dt.date | None = None
    completion_likelihood: float | None = None
    completion_date_85pct: dt.date | None = None
    pbi_completed_by_deadline_85pct: int | None = None
    completion_date_85pct_with_holidays: dt.date | None = None


class ForecastSimulationCreate(ForecastSimulationBase):
    pass


class ForecastSimulationUpdate(BaseModel):
    note: str | None = None
    simulation_date: dt.date | None = None
    pbi_remaining: int | None = None
    pbi_done: int | None = None
    planned_pbi_done: int | None = None
    unplanned_pbi_done: int | None = None
    planned_pbi_keys: str | None = None
    unplanned_pbi_keys: str | None = None
    traditional_forecasting: str | None = None
    code_freeze_deadline: dt.date | None = None
    completion_likelihood: float | None = None
    completion_date_85pct: dt.date | None = None
    pbi_completed_by_deadline_85pct: int | None = None
    completion_date_85pct_with_holidays: dt.date | None = None


class ForecastSimulation(ForecastSimulationBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    project_id: int


class Snapshot(SnapshotBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    project_id: int


# ---------- Project ----------

class ProjectBase(BaseModel):
    code: str
    name: str
    status: str = "Kick-off"
    scope: str | None = None
    start_date: dt.date | None = None
    code_freeze_date: dt.date | None = None
    planned_finish_date: dt.date | None = None
    dev_start_date: dt.date | None = None
    jira_jql: str | None = None
    change_order_url: str | None = None
    change_order_label: str | None = None
    is_current: bool = False


class ProjectCreate(ProjectBase):
    pass


class ProjectGanttOrder(BaseModel):
    # Id degli increment nell'ordine voluto, dall'alto verso il basso.
    project_ids: list[int]


class ProjectUpdate(BaseModel):
    code: str | None = None
    name: str | None = None
    status: str | None = None
    scope: str | None = None
    start_date: dt.date | None = None
    code_freeze_date: dt.date | None = None
    planned_finish_date: dt.date | None = None
    dev_start_date: dt.date | None = None
    jira_jql: str | None = None
    change_order_url: str | None = None
    change_order_label: str | None = None
    is_current: bool | None = None


class ProjectListItem(ProjectBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    # Sola lettura qui: si modifica con PUT /api/projects/gantt-order.
    gantt_order: int | None = None
    created_at: dt.datetime
    updated_at: dt.datetime


# ---------- Increment ----------

class IncrementBase(BaseModel):
    code: str
    notes: str | None = None
    start_date: dt.date | None = None
    end_date: dt.date | None = None
    estimated_budget_hours: float = 0
    estimated_budget_material: float = 0
    project_id: int | None = None


class IncrementCreate(IncrementBase):
    pass


class IncrementUpdate(BaseModel):
    code: str | None = None
    notes: str | None = None
    start_date: dt.date | None = None
    end_date: dt.date | None = None
    estimated_budget_hours: float | None = None
    estimated_budget_material: float | None = None
    project_id: int | None = None


class SubProjectCreate(BaseModel):
    name: str
    budget_hours: float = 0
    order: int = 0


class SubProjectUpdate(BaseModel):
    name: str | None = None
    budget_hours: float | None = None
    # None esplicito = scollega il sotto-progetto dal rilascio.
    project_id: int | None = None


class SubProject(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    increment_id: int
    # Codice del progetto di cui fa parte (es. "PTIH-MA26").
    increment_code: str
    name: str
    budget_hours: float = 0
    # Ore usate: l'Actual nell'ultimo snapshot dello Storico del progetto.
    actual_hours: float = 0
    project_id: int | None = None
    order: int = 0


class Increment(IncrementBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: dt.datetime
    updated_at: dt.datetime
    sub_projects: list[SubProject] = []


class ProjectDetail(ProjectListItem):
    phases: list[Phase] = []
    # Progetti (budget/rendicontazione) collegati a questo rilascio: un
    # rilascio puo' averne piu' di uno (vedi Increment.project_id).
    progetti: list[Increment] = []
    # Sotto-progetti collegati a questo rilascio, di progetti non collegati
    # per intero.
    sub_projects: list[SubProject] = []


class IncrementDetail(Increment):
    """budget_hours_total/logged_hours_total sommano solo le voci di budget
    con is_hours=True (l'Andamento puo' contenere anche voci non-ore, es.
    "Travels"); budget_material_total somma le altre. Le ore usate vengono
    solo dall'ultimo IncrementSnapshot (0 se l'Andamento e' ancora vuoto),
    mai dal Project (rilascio) collegato. Il progetto non ha un proprio
    backlog Jira, quindi backlog/% completamento restano invece presi pari
    pari da li'."""

    project: ProjectListItem | None = None
    backlog_total: int = 0
    backlog_in_scope: int = 0
    backlog_done: int = 0
    percent_complete: float = 0.0
    budget_hours_total: float
    budget_material_total: float
    logged_hours_total: float = 0.0
    actual_material_total: float = 0.0
    dev_logged_hours_total: float = 0.0
    percent_budget_used: float = 0.0
    percent_material_used: float = 0.0
    budget_lines: list[IncrementBudgetLine] = []
    snapshots: list[IncrementSnapshot] = []


# ---------- Documents ----------

class DocumentRevisionMeta(BaseModel):
    """Versione e testo di revisione proposti (modificabili) per il popup
    mostrato prima di scaricare un qualunque documento generato."""

    next_version: int
    last_revision_text: str


class PprDeliverable(BaseModel):
    """Una riga della sezione "Deliverable Check" del foglio Planning
    Review: row/name sono fissi (letti dal template), included/filename/
    notes sono scelti dall'utente nel popup di generazione."""

    row: int
    name: str
    included: bool = True
    filename: str = ""
    notes: str = ""


class PprDocumentMeta(DocumentRevisionMeta):
    deliverables: list[PprDeliverable]


# ---------- Dashboard ----------

class DashboardMetrics(BaseModel):
    backlog_total: int
    backlog_in_scope: int
    backlog_done: int
    percent_complete: float
    logged_hours_total: float
    dev_logged_hours_total: float
    # Somma dei budget ore dei progetti collegati all'increment (0 se non ce
    # ne sono) e quota gia' consumata da logged_hours_total (None senza budget).
    budget_hours_total: float = 0.0
    percent_budget_used: float | None = None
    percent_time_elapsed: float | None
    spi: float | None
    completion_source: str
    logged_hours_source: str
    last_snapshot_date: dt.date | None
    phases: list[Phase]


class PbiDoneCount(BaseModel):
    issue_type: str
    count: int


class OverviewMetrics(BaseModel):
    # PBI (Story/Bug/Activity, intero progetto Jira configurato in
    # Configurazione) messi a Done negli ultimi 12 mesi, per il grafico a
    # ciambella della Dashboard generale. Interrogato live su Jira (non dal
    # backlog locale, che copre solo gli increment tracciati in questa app).
    done_last_12_months: list[PbiDoneCount]
    done_last_12_months_total: int
    # Quante delle Story sopra hanno "Enhancement" = Yes.
    story_enhancement_count: int = 0
    # Quanti dei Bug sopra hanno "Source Type" = Complaint: evidenziato a
    # parte perche' un Bug segnalato da cliente (Complaint) ha un peso
    # diverso da uno trovato internamente.
    bug_complaint_count: int = 0
    # Quanti dei Bug sopra sono aperti/chiusi dal bot di security scan
    # (reporter = jira.security-pipeline, vedi jira_client.CVE_BUG_REPORTER_EMAIL):
    # spesso chiusi in blocco lo stesso giorno, non lavoro di sviluppo vero e
    # proprio, quindi vanno evidenziati a parte per non gonfiare il numero.
    bug_cve_count: int = 0
    # Valorizzato se Jira non e' configurato (base URL/email/token) o manca
    # la Jira project key in Configurazione: il frontend mostra questo
    # messaggio al posto del grafico invece di un errore.
    error: str | None = None


class CycleTimePoint(BaseModel):
    key: str
    issue_type: str
    finish_date: dt.date
    cycle_time_days: float
    # Bug generato/chiuso dal bot di security scan (vedi
    # OverviewMetrics.bug_cve_count): il frontend lo mostra con uno stile
    # diverso invece di un colore/serie a se', per non aggiungere una nuova
    # tinta alla palette categoriale gia' validata.
    is_cve: bool = False


class CycleTimeMetrics(BaseModel):
    points: list[CycleTimePoint]
    p50: float | None = None
    p85: float | None = None
    p95: float | None = None
    error: str | None = None


class BugsOpenedMonth(BaseModel):
    # Mese solare di apertura, formato "YYYY-MM".
    month: str
    complaint: int
    # Esclusi i CVE del bot di security scan, contati a parte in cve.
    non_complaint: int
    cve: int = 0


class BugStatusCount(BaseModel):
    status: str
    count: int


class BugsOpenedMetrics(BaseModel):
    # Bug aperti (created) per mese negli ultimi 12 mesi, divisi tra
    # Complaint (Source Type = Complaint) e non Complaint. Tutti i mesi della
    # finestra sono presenti, anche a zero, cosi' l'andamento non ha buchi.
    # I CVE del bot di security scan sono una terza categoria a se'.
    months: list[BugsOpenedMonth]
    # Gli stessi Bug (CVE esclusi) raggruppati per stato Jira attuale,
    # ordinati per numerosita' decrescente.
    by_status: list[BugStatusCount] = []
    error: str | None = None


# ---------- Configurazione ----------

class AppSettingsPublic(BaseModel):
    """Il token vero non viene mai restituito al frontend: solo se e'
    impostato e un'anteprima mascherata, per confermare quale sia senza
    esporlo (es. dopo averlo incollato per errore in un posto sbagliato)."""

    jira_base_url: str | None = None
    jira_email: str | None = None
    jira_api_token_set: bool = False
    jira_api_token_preview: str | None = None
    # Inserita a mano (Jira non la espone via API, vedi models.AppSettings):
    # solo per l'avviso di scadenza in UI.
    jira_api_token_expires_at: dt.date | None = None
    team_sw_base_jql: str | None = None
    team_embedded_base_jql: str | None = None


class AppSettingsUpdate(BaseModel):
    jira_base_url: str | None = None
    jira_email: str | None = None
    # None o stringa vuota = lascia invariato il token esistente (il campo
    # in UI e' sempre vuoto, non mostra mai il valore vero): va valorizzato
    # solo per impostarne uno nuovo.
    jira_api_token: str | None = None
    jira_api_token_expires_at: dt.date | None = None
    team_sw_base_jql: str | None = None
    team_embedded_base_jql: str | None = None


class TestConnectionResult(BaseModel):
    ok: bool
    message: str


# ---------- Dashboard generale: snapshot ----------

class DashboardSnapshotTeamData(BaseModel):
    # Le stesse risposte degli endpoint live della Dashboard generale, per
    # un team, congelate al momento dello snapshot.
    overview_current: OverviewMetrics
    overview_previous: OverviewMetrics
    cycle_time: CycleTimeMetrics
    bugs_opened: BugsOpenedMetrics


class DashboardSnapshotCreate(BaseModel):
    note: str | None = None


class DashboardSnapshotUpdate(BaseModel):
    note: str | None = None


class DashboardSnapshotSummary(BaseModel):
    id: int
    snapshot_date: dt.date
    created_at: dt.datetime
    note: str | None = None
    # Almeno un grafico di un team ha restituito un errore (Jira non
    # raggiungibile, JQL del team non configurata...): lo snapshot esiste ma
    # quel grafico mostrera' il messaggio d'errore invece dei dati.
    has_errors: bool = False


class DashboardSnapshotDetail(DashboardSnapshotSummary):
    # Chiave = team ("sw", "embedded").
    teams: dict[str, DashboardSnapshotTeamData]


# ---------- Complaints ----------

class Complaint(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    jira_key: str
    summary: str | None = None
    jira_status: str | None = None
    fix_versions: str | None = None
    severity: str | None = None
    jira_created: dt.date | None = None
    jira_resolved: dt.date | None = None
    labels: str | None = None
    architecture: str | None = None
    architecture_manual: bool = False
    salesforce_case_number: str | None = None
    salesforce_case_id: str | None = None
    salesforce_status: Literal["Aperto", "Chiuso"] = "Aperto"
    customer_site: str | None = None
    customer_site_manual: bool = False
    last_synced_at: dt.datetime | None = None


class ComplaintUpdate(BaseModel):
    salesforce_status: Literal["Aperto", "Chiuso"] | None = None
    # Stringa vuota/None = torna al valore ricavato dalle label Jira (vale
    # sia per l'architettura sia per il sito).
    architecture: Literal["Legacy", "NA5", "NA6", "NA7", ""] | None = None
    customer_site: str | None = None


class ComplaintsSettings(BaseModel):
    base_jql: str
