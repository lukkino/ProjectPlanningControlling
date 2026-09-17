import datetime as dt

from pydantic import BaseModel, ConfigDict


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


# ---------- BudgetLine ----------

class BudgetLineBase(BaseModel):
    role_name: str
    budget_hours: float = 0
    order: int = 0


class BudgetLineCreate(BudgetLineBase):
    pass


class BudgetLineUpdate(BaseModel):
    role_name: str | None = None
    budget_hours: float | None = None
    order: int | None = None


class BudgetLine(BudgetLineBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    project_id: int


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
    estimated_budget_hours: float = 0
    estimated_budget_material: float = 0
    jira_jql: str | None = None
    change_order_url: str | None = None
    change_order_label: str | None = None


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    code: str | None = None
    name: str | None = None
    status: str | None = None
    scope: str | None = None
    start_date: dt.date | None = None
    code_freeze_date: dt.date | None = None
    planned_finish_date: dt.date | None = None
    dev_start_date: dt.date | None = None
    estimated_budget_hours: float | None = None
    estimated_budget_material: float | None = None
    jira_jql: str | None = None
    change_order_url: str | None = None
    change_order_label: str | None = None


class ProjectListItem(ProjectBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: dt.datetime
    updated_at: dt.datetime


class ProjectDetail(ProjectListItem):
    phases: list[Phase] = []
    budget_lines: list[BudgetLine] = []


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
    budget_hours_total: float
    logged_hours_total: float
    dev_logged_hours_total: float
    percent_budget_used: float
    percent_time_elapsed: float | None
    spi: float | None
    completion_source: str
    logged_hours_source: str
    last_snapshot_date: dt.date | None
    phases: list[Phase]
    budget_lines: list[BudgetLine]
