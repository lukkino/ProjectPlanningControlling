import datetime as dt
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator, computed_field


# ---------- Phase ----------

class PhaseBase(BaseModel):
    name: str
    original_date: dt.date | None = None
    planned_date: dt.date | None = None
    actual_date: dt.date | None = None
    order: int = 0
    notes: str | None = None


class PhaseCreate(PhaseBase):
    pass


class PhaseUpdate(BaseModel):
    name: str | None = None
    original_date: dt.date | None = None
    planned_date: dt.date | None = None
    actual_date: dt.date | None = None
    order: int | None = None
    notes: str | None = None


class PhaseDateChange(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    old_date: dt.date | None
    new_date: dt.date | None
    changed_at: dt.datetime


class Phase(PhaseBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    project_id: int
    changes: list[PhaseDateChange] = []


# ---------- NonWorkingDay ----------

class NonWorkingDayBase(BaseModel):
    start_date: dt.date
    end_date: dt.date
    description: str | None = None


class NonWorkingDayCreate(NonWorkingDayBase):
    pass


class NonWorkingDayUpdate(BaseModel):
    start_date: dt.date | None = None
    end_date: dt.date | None = None
    description: str | None = None


class NonWorkingDay(NonWorkingDayBase):
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

class IncrementSnapshotValueEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    hours: float


class IncrementSnapshotValueEntryUpdate(BaseModel):
    hours: float = Field(ge=0)


class IncrementSnapshotValue(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    budget_line_id: int
    budget_value: float
    actual_value: float
    # Ripartizione dell'Actual (voci in ore: Project Management, Develop,
    # ...): se presente, actual_value ne e' la somma.
    entries: list[IncrementSnapshotValueEntry] = []


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
    # Reparto DEV del file di budget e societa' delle risorse stimate.
    department: str | None = None
    company: Literal["SpA", "SA", "TPM"] = "SpA"
    order: int = 0


class IncrementResourceTypeCreate(IncrementResourceTypeBase):
    pass


class IncrementResourceTypeUpdate(BaseModel):
    name: str | None = None
    resource_count: float | None = Field(default=None, ge=0)
    hours_per_day: float | None = Field(default=None, ge=0, le=24)
    department: str | None = None
    company: Literal["SpA", "SA", "TPM"] | None = None
    order: int | None = None


class MemberAbsenceCreate(BaseModel):
    start_date: dt.date
    end_date: dt.date
    kind: Literal["Ferie", "Malattia", "Altro"] = "Ferie"
    note: str | None = None

    @model_validator(mode="after")
    def _check_range(self):
        if self.end_date < self.start_date:
            raise ValueError("La data di fine delle ferie è precedente alla data di inizio")
        return self


class MemberAbsence(MemberAbsenceCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
    member_id: int


class TeamMemberCreate(BaseModel):
    name: str
    # None = le ore/giorno di default della tipologia.
    hours_per_day: float | None = Field(default=None, ge=0, le=24)
    # None = la societa' della tipologia.
    company: Literal["SpA", "SA", "TPM"] | None = None


class TeamMemberUpdate(BaseModel):
    name: str | None = None
    hours_per_day: float | None = Field(default=None, ge=0, le=24)
    company: Literal["SpA", "SA", "TPM"] | None = None
    order: int | None = None


class TeamMember(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    resource_type_id: int
    name: str
    hours_per_day: float
    company: str = "SpA"
    order: int
    absences: list[MemberAbsence] = []


class IncrementResourceType(IncrementResourceTypeBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    increment_id: int
    # Persone della tipologia: la composizione del team di progetto.
    members: list[TeamMember] = []


class HoursCalculatorUpdate(BaseModel):
    start_date: dt.date | None = None
    end_date: dt.date | None = None
    vacation_days: float | None = Field(default=None, ge=0)


class TeamAbsenceRef(BaseModel):
    """Assenza inserita nel Team del Carico team (vedi HoursCalculator)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    start_date: dt.date
    end_date: dt.date
    kind: str = "Ferie"
    note: str | None = None


class HoursCalculator(BaseModel):
    """start_date/end_date null = non impostate: la UI usa le date del
    progetto."""

    start_date: dt.date | None = None
    end_date: dt.date | None = None
    vacation_days: float = 0
    resource_types: list[IncrementResourceType] = []
    # Assenze delle persone del Team del Carico team (stesso proprietario),
    # per nome normalizzato (minuscolo, spazi singoli): valgono anche per le
    # persone del progetto con lo stesso nome, senza reinserirle.
    team_absences: dict[str, list[TeamAbsenceRef]] = {}
    # Nomi delle persone del Team, da proporre aggiungendo una persona.
    team_people: list[str] = []


# ---------- Budget di progetto (vedi services/budget.py) ----------

Company = Literal["SpA", "SA", "TPM"]


class HoursDetailRowInput(BaseModel):
    """Una riga mandata da "Aggiorna ore progetto": una tipologia del
    calcolatore e una societa'."""

    name: str
    department: str | None = None
    company: Company = "SpA"
    resource_count: float = Field(default=0, ge=0)
    hours: float = Field(default=0, ge=0)


class HoursDetailRowUpdate(BaseModel):
    hours: float | None = Field(default=None, ge=0)
    department: str | None = None


class HoursDetailRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    department: str | None = None
    company: str
    resource_count: float
    hours: float


class HoursDetail(BaseModel):
    rows: list[HoursDetailRow] = []
    # Budget congelato il (None = non congelato).
    frozen_at: dt.datetime | None = None


class MaterialWrite(BaseModel):
    """Una riga materiali (bozza o review di budget)."""

    category: str | None = None
    section: str | None = None
    description: str | None = None
    unit_cost: float | None = None
    units: float | None = None
    modules: float | None = None


class MaterialFields(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    category: str
    section: str | None = None
    description: str
    unit_cost: float
    units: float
    modules: float

    @computed_field
    @property
    def amount(self) -> float:
        return self.unit_cost * self.units * self.modules


class MaterialCost(MaterialFields):
    id: int


class MaterialBudgetRow(MaterialFields):
    pass


class MaterialBudget(BaseModel):
    # Dettaglio materiali (budget iniziale), da "Aggiorna materiali
    # progetto"; published_at None se non e' mai stato aggiornato.
    rows: list[MaterialBudgetRow]
    published_at: dt.datetime | None = None
    frozen_at: dt.datetime | None = None


class BudgetStatus(BaseModel):
    frozen_at: dt.datetime | None = None


class BudgetDepartment(BaseModel):
    code: str
    name: str


class BudgetCatalog(BaseModel):
    departments: list[BudgetDepartment]
    companies: list[str]
    categories: list[str]
    sections: list[str]
    categories_without_sections: list[str]


class BudgetReviewWrite(BaseModel):
    name: str | None = None
    review_date: dt.date | None = None
    note: str | None = None


class BudgetReviewHoursWrite(BaseModel):
    department: str | None = None
    description: str | None = None
    spa: float | None = None
    sa: float | None = None
    tpm: float | None = None


class BudgetReviewHours(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    department: str
    description: str
    spa: float
    sa: float
    tpm: float


class BudgetReviewMaterial(MaterialFields):
    id: int


class BudgetReview(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    review_date: dt.date | None = None
    note: str | None = None
    order: int
    hours_items: list[BudgetReviewHours] = []
    material_items: list[BudgetReviewMaterial] = []


# ---------- BacklogItem ----------

# Fase a cui serve un'attivita' di servizio (vedi models.BacklogItem.activity_phase).
ActivityPhase = Literal["execution", "deployment", "release"]


class BacklogItemBase(BaseModel):
    jira_key: str
    priority_order: float = 0
    ready_for_refinement: bool = False
    in_scope: bool = True
    included_in_codefreeze: bool = True
    is_activity: bool = False
    activity_phase: ActivityPhase | None = None
    scenarios_link: str | None = None
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
    predecessors: str | None = None
    milestone_phase_id: int | None = None
    baseline_start: dt.date | None = None
    baseline_finish: dt.date | None = None


class BacklogItemCreate(BacklogItemBase):
    pass


class BacklogItemUpdate(BaseModel):
    priority_order: float | None = None
    ready_for_refinement: bool | None = None
    in_scope: bool | None = None
    included_in_codefreeze: bool | None = None
    is_activity: bool | None = None
    activity_phase: ActivityPhase | None = None
    scenarios_link: str | None = None
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
    predecessors: str | None = None
    milestone_phase_id: int | None = None
    baseline_start: dt.date | None = None
    baseline_finish: dt.date | None = None


class BacklogItemBulkUpdate(BacklogItemUpdate):
    id: int


class BacklogItem(BacklogItemBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    project_id: int
    archived_at: dt.datetime | None = None
    summary: str | None = None
    description: str | None = None
    change_description: str | None = None
    problem_cause: str | None = None
    components: str | None = None
    dev_effort_hours: float | None = None
    impacts_on: str | None = None
    assignee: str | None = None
    issue_type: str | None = None
    jira_status: str | None = None
    labels: str | None = None
    parent_key: str | None = None
    parent_summary: str | None = None
    implemented_by_json: str | None = None
    last_synced_at: dt.datetime | None = None
    status: str


class BaselineResult(BaseModel):
    # Item a cui e' stata fissata la baseline e item in scope, non Done, senza
    # date pianificate (rimasti senza baseline).
    baselined: int
    without_dates: int


class SyncResult(BaseModel):
    created: int
    updated: int
    removed: int = 0
    # Backlog: item archiviati tornati perche' rientrati nella JQL.
    restored: int = 0
    total_matched: int
    errors: list[str] = []
    # Complaints: Case trovati in Salesforce (None = lettura non fatta).
    salesforce_matched: int | None = None


class SyncProgress(BaseModel):
    """Avanzamento della sync Backlog in corso: phase e' "search", "changelog",
    "details" o "saving" (vedi search_issues), "idle" se nessuna sync gira."""

    phase: str
    done: int = 0
    total: int = 0


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
    # JSON dei parametri Monte Carlo (vedi models.ForecastSimulation).
    mc_params: str | None = None


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
    mc_params: str | None = None


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
    scope_narrative: str | None = None
    dev_start_date: dt.date | None = None
    jira_jql: str | None = None
    change_order_url: str | None = None
    change_order_label: str | None = None
    co_software_involved: bool | None = None
    co_status: str | None = None
    co_status_checked_at: dt.datetime | None = None
    scenarios_folder: str | None = None
    review_documents_folder: str | None = None
    is_current: bool = False
    release_date: dt.date | None = None


class ProjectCreate(ProjectBase):
    pass


class ProjectGanttOrder(BaseModel):
    # Id degli increment nell'ordine voluto, dall'alto verso il basso.
    project_ids: list[int]


class SidebarPin(BaseModel):
    pinned: bool


class ProjectUpdate(BaseModel):
    code: str | None = None
    name: str | None = None
    status: str | None = None
    scope: str | None = None
    scope_narrative: str | None = None
    dev_start_date: dt.date | None = None
    jira_jql: str | None = None
    change_order_url: str | None = None
    change_order_label: str | None = None
    co_software_involved: bool | None = None
    co_status: str | None = None
    co_status_checked_at: dt.datetime | None = None
    scenarios_folder: str | None = None
    review_documents_folder: str | None = None
    is_current: bool | None = None
    release_date: dt.date | None = None


class ProjectListItem(ProjectBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    # Sola lettura: date aggiornate delle fasi Kick-off, Code freeze e
    # Release to Market, si modificano dalle fasi dell'increment.
    start_date: dt.date | None = None
    code_freeze_date: dt.date | None = None
    planned_finish_date: dt.date | None = None
    # Sola lettura qui: si modifica con PUT /api/projects/gantt-order.
    gantt_order: int | None = None
    # Sola lettura qui: si modifica con PUT /api/projects/{id}/pinned.
    sidebar_pinned: bool = False
    created_at: dt.datetime
    updated_at: dt.datetime


class ScenariosStatus(BaseModel):
    # Cartella Scenarios dell'increment (None = non impostata) e se esiste
    # davvero su file system.
    folder: str | None
    folder_exists: bool
    # Chiave Jira -> nome del file pptx degli scenari gia' presente.
    files: dict[str, str]


class ScenarioFile(BaseModel):
    filename: str


class FolderStatus(BaseModel):
    # Cartella dell'increment (None = non impostata) e se esiste davvero.
    folder: str | None
    folder_exists: bool


class SavedFile(BaseModel):
    filename: str


class ScenarioBrowseResult(BaseModel):
    # None = finestra chiusa senza scegliere un file.
    path: str | None


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
    # Budget congelato il (None = non ancora congelato).
    budget_frozen_at: dt.datetime | None = None
    budget_corrected_at: dt.datetime | None = None
    # Sola lettura qui: si modifica con PUT /api/increments/{id}/pinned.
    sidebar_pinned: bool = False
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


class ReleaseComponentWrite(BaseModel):
    pn: str | None = None
    component: str | None = None
    fix_version: str | None = None
    abbreviation: str | None = None
    artifactory_url: str | None = None
    detail: str | None = None
    note: str | None = None


class ReleaseComponentRead(ReleaseComponentWrite):
    id: int

    model_config = ConfigDict(from_attributes=True)


class ReleaseWrite(BaseModel):
    ptih_code: str | None = None
    increment_code: str | None = None
    objective: str | None = None
    start_date: dt.date | None = None
    expected_release_date: dt.date | None = None
    actual_release_date: dt.date | None = None
    change_order: str | None = None
    process: str | None = None


class ReleaseRead(ReleaseWrite):
    id: int
    components: list[ReleaseComponentRead]
    # Increment dell'app a cui la release appartiene (stesso codice): le sue
    # date vengono da li' e in Releases sono in sola lettura.
    project_id: int | None = None
    # Scopo discorsivo dell'increment (HTML), se c'e': in Releases sostituisce
    # lo Scopo scritto nella release (objective), in sola lettura.
    scope_narrative: str | None = None

    model_config = ConfigDict(from_attributes=True)


class ScopeNarrative(BaseModel):
    html: str


class IncrementRequirement(BaseModel):
    key: str
    summary: str = ""
    status: str = ""
    components: list[str] = []
    labels: list[str] = []
    # Perche' resta fuori dal documento; vuoto se ci va.
    reason: str = ""


class IncrementRequirements(BaseModel):
    """Story o User Need con la fix version dell'increment."""

    included: list[IncrementRequirement]
    left_out: list[IncrementRequirement]


class RequirementCheckItem(BaseModel):
    key: str
    summary: str = ""
    status: str = ""
    # Campo Jira "Epic Category": "UN" per le User Need.
    category: str = ""
    # Issue che sostituiscono questa (link Jira "is expanded by").
    expanded_by: list[str] = []
    # Ha la fix version di questo increment: se non e' ancora in Done e'
    # attesa nel documento, non e' un'anomalia.
    current_increment: bool = False


class RequirementsCheck(BaseModel):
    """Confronto tra un foglio di requisiti di un documento ("User Needs" o
    "Design Input - Stories") e le issue corrispondenti su Jira."""

    jira_project: str
    document_count: int
    # Issue su Jira in Done e non obsolete.
    jira_valid_count: int
    # Issue su Jira in Done ma obsolete (sostituite da un'altra).
    jira_obsolete_count: int
    missing: list[RequirementCheckItem]
    obsolete_in_document: list[RequirementCheckItem]
    not_done_in_document: list[RequirementCheckItem]
    # Nel documento, ma su Jira sono Epic di un'altra categoria (non "UN").
    wrong_category_in_document: list[RequirementCheckItem]
    # Nel documento, ma su Jira non c'e' un'issue di quel tipo con questa chiave.
    unknown_in_document: list[str]
    repeated_in_document: list[str]


class PprDeliverable(BaseModel):
    """Una riga della sezione "Deliverable Check" del foglio Planning
    Review: row (posizione nell'elenco) e name sono fissi, included/
    filename/notes sono scelti dall'utente nel popup di generazione."""

    row: int
    name: str
    included: bool = True
    filename: str = ""
    notes: str = ""


class PprReviewDeliverable(BaseModel):
    # Un documento atteso alla review (Deliverable Check del template).
    name: str
    requirement: str | None = None  # es. "Document signed"
    owner: str | None = None  # dal Task Guideline, None se non trovato


class PprDocumentMeta(DocumentRevisionMeta):
    deliverables: list[PprDeliverable]


class PprInspectRequest(BaseModel):
    """Un documento caricato nel popup, in base64: "previous" = ultima
    versione dello stesso documento, "previous_phase" = ultimo documento
    della fase precedente."""

    role: Literal["previous", "previous_phase"]
    file_b64: str


class WorkbookInspectRequest(BaseModel):
    """Design Input o User Needs scelto nel popup di esportazione, in base64."""

    file_b64: str


class PprInspection(BaseModel):
    title: str
    last_version: int | None = None
    # Solo Design Input e User Needs.
    last_author: str | None = None
    last_description: str | None = None
    # Solo per l'ultimo Planning: i Deliverable Check gia' compilati.
    deliverables: list[PprDeliverable] | None = None
    # Documento col vecchio template: se ne usano solo versione e history.
    old_template: bool = False


class PprCandidate(BaseModel):
    """Un documento PPR della cartella review proposto nel popup: info se
    e' del tipo giusto, altrimenti error col motivo."""

    filename: str
    modified: dt.datetime
    info: PprInspection | None = None
    error: str | None = None


class PprGenerateRequest(BaseModel):
    version: int
    revision_text: str
    deliverables: list[PprDeliverable] | None = None
    # Ogni documento precedente arriva caricato dal disco (base64) oppure
    # come nome di un file della cartella review dell'increment.
    previous_b64: str | None = None
    previous_phase_b64: str | None = None
    previous_filename: str | None = None
    previous_phase_filename: str | None = None


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
    # "progetti" (somma dei progetti collegati), "snapshot" o "backlog".
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
    # Quando i dati sono stati estratti da Jira (UTC): vedi CachedExtraction.
    fetched_at: dt.datetime | None = None


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

class TsbActivity(BaseModel):
    key: str
    summary: str
    # Stato Jira dell'activity (None per i dati salvati prima di questo campo,
    # fino alla sync successiva).
    status: str | None = None


class Complaint(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    jira_key: str
    summary: str | None = None
    jira_status: str | None = None
    fix_versions: str | None = None
    severity: str | None = None
    rejection_reason: str | None = None
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
    tsb_activities: list[TsbActivity] = []
    last_synced_at: dt.datetime | None = None
    sf_record_id: str | None = None
    sf_status: str | None = None
    sf_account: str | None = None
    sf_inpeco_priority: str | None = None
    sf_customer_impact: str | None = None
    sf_safety: str | None = None
    sf_severity: str | None = None
    sf_synced_at: dt.datetime | None = None

    # Nel database e' JSON (vedi models.Complaint.tsb_activities).
    @field_validator("tsb_activities", mode="before")
    @classmethod
    def _parse_tsb_activities(cls, value):
        if isinstance(value, str):
            return json.loads(value)
        return value or []


# Sezione Disallineamenti dei Complaints (GET /api/complaints/mismatches).
class MismatchComplaint(BaseModel):
    jira_key: str
    summary: str | None
    jira_status: str | None
    jira_created: dt.date | None
    salesforce_case_number: str | None
    # Riferimento solo a un ticket del vecchio sistema AX (non in Salesforce).
    legacy_ax: bool


class MismatchLink(BaseModel):
    """Complaint col suo Case: JiraID del Case diverso, o stati diversi."""

    complaint: MismatchComplaint
    sf_record_id: str
    sf_case_number: str | None
    sf_status: str | None
    sf_jira_key: str | None
    sf_closed: bool


class MismatchCase(BaseModel):
    """Case del perimetro senza complaint. reason: no_jira_key (JiraID
    vuoto), other_project (JiraID di un altro progetto Jira), not_a_complaint
    (issue PTBSYS fuori dalla JQL dei complaint), linked_elsewhere (il
    complaint del JiraID e' collegato a un altro Case)."""

    record_id: str
    case_number: str | None
    status: str | None
    is_closed: bool | None
    account: str | None
    created: dt.date | None
    jira_key: str | None
    reason: Literal["no_jira_key", "other_project", "not_a_complaint", "linked_elsewhere"]


class ComplaintMismatches(BaseModel):
    synced_at: dt.datetime | None
    scope: str
    scope_cases: int
    complaints_without_case: list[MismatchComplaint]
    cases_without_complaint: list[MismatchCase]
    wrong_jira_link: list[MismatchLink]
    status_mismatch: list[MismatchLink]


class ComplaintUpdate(BaseModel):
    salesforce_status: Literal["Aperto", "Chiuso"] | None = None
    # Stringa vuota/None = torna al valore ricavato dalle label Jira (vale
    # sia per l'architettura sia per il sito).
    architecture: Literal["Legacy", "NA5", "NA6", "NA7", ""] | None = None
    customer_site: str | None = None


class ComplaintsSettings(BaseModel):
    base_jql: str


class ReleaseOrder(BaseModel):
    # Id delle release nell'ordine voluto, dall'alto verso il basso.
    release_ids: list[int]


class ComponentCatalogWrite(BaseModel):
    name: str
    pn_family: str | None = None


class ComponentCatalogItem(ComponentCatalogWrite):
    # PN che si proporrebbe aggiungendo il componente a un increment.
    next_pn: str | None = None


class IncrementComponentCreate(BaseModel):
    name: str


class IncrementComponentUpdate(BaseModel):
    pn: str | None = None
    fix_version: str | None = None
    abbreviation: str | None = None
    artifactory_url: str | None = None
    detail: str | None = None
    note: str | None = None


class IncrementComponentRead(BaseModel):
    id: int
    name: str
    pn: str | None
    fix_version: str | None
    abbreviation: str | None
    artifactory_url: str | None
    detail: str | None
    note: str | None
    # Altri increment (Releases o tab di altri increment) con lo stesso PN.
    pn_used_by: list[str]


# ---------- Release Notice ----------


class ReleaseNoticeComponent(BaseModel):
    pn: str = ""
    name: str = ""
    # Sigla e versione in grassetto, es. "PSDA_6.0.0".
    code: str = ""


class ReleaseNoticeMeta(BaseModel):
    subject: str
    components: list[ReleaseNoticeComponent]
    change_order_label: str | None
    change_order_url: str | None
    has_scope_narrative: bool
    # Cosa manca per una Notice completa (avvisi nel popup, non bloccanti).
    warnings: list[str]
    template: "ReleaseNoticeTemplateInfo"


class ReleaseNoticeRequest(BaseModel):
    components: list[ReleaseNoticeComponent]
    pn_links: dict[str, str] = {}
    change_order_label: str | None = None
    change_order_url: str | None = None
    compatibility_matrix_url: str | None = None
    note: str | None = None


class ReleaseNoticePlaceholder(BaseModel):
    token: str
    description: str


class ReleaseNoticeTemplateInfo(BaseModel):
    # True = template caricato dall'utente, False = quello predefinito.
    custom: bool
    updated_at: dt.datetime | None
    unknown_placeholders: list[str]
    placeholders: list[ReleaseNoticePlaceholder]


class ReleaseNoticeHtml(BaseModel):
    subject: str
    html: str
    text: str


ReleaseNoticeMeta.model_rebuild()


# ---------- Utenti e login ----------

Role = Literal["viewer", "editor", "admin"]


class AuthStatus(BaseModel):
    setup_required: bool


class LoginRequest(BaseModel):
    username: str
    password: str


class SetupRequest(BaseModel):
    username: str
    display_name: str = ""
    email: str | None = None
    password: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


class UserRead(BaseModel):
    id: int
    username: str
    display_name: str
    email: str | None
    role: Role
    is_active: bool
    auth_provider: str
    created_at: dt.datetime
    last_login_at: dt.datetime | None

    model_config = ConfigDict(from_attributes=True)


class UserCreate(BaseModel):
    username: str
    display_name: str = ""
    email: str | None = None
    role: Role = "viewer"
    password: str


class UserUpdate(BaseModel):
    display_name: str | None = None
    email: str | None = None
    role: Role | None = None
    is_active: bool | None = None
    # Valorizzata = nuova password impostata dall'admin.
    password: str | None = None


class Suggestions(BaseModel):
    """Valori di esempio per i campi vuoti (vedi routers/suggestions.py)."""

    source: str | None = None
    team_sw_base_jql: str | None = None
    team_embedded_base_jql: str | None = None
    complaints_base_jql: str | None = None
    # Con "{code}" al posto del codice dell'increment.
    increment_jql_template: str | None = None


class EarnedValueItem(BaseModel):
    id: int
    jira_key: str
    summary: str | None
    issue_type: str | None
    status: str
    assignee: str | None
    # Budget in ore: stima dev + test, altrimenti Sizing x 8 h ("stima"/"sizing").
    budget: float | None
    budget_source: str | None
    completion: float | None
    pv: float
    ev: float
    ac: float
    sv: float
    cpi: float | None
    plan_start: dt.date | None
    plan_finish: dt.date | None
    # "baseline", "aggiornata" o "effettiva": da dove vengono le date del PV.
    plan_source: str | None


class EarnedValuePoint(BaseModel):
    day: dt.date
    pv: float
    ev: float | None
    ac: float | None


class EarnedValue(BaseModel):
    today: dt.date
    has_baseline: bool
    bac: float
    pv: float
    ev: float
    ac: float
    sv: float
    cv: float
    spi: float | None
    cpi: float | None
    eac: float | None
    etc: float | None
    vac: float | None
    plan_start: dt.date | None
    plan_finish: dt.date | None
    earned_schedule: dt.date | None
    schedule_delay_days: float | None
    forecast_finish: dt.date | None
    items_without_budget: int
    items_without_plan: int
    done_without_hours: int
    unbudgeted_logged_hours: float
    items: list[EarnedValueItem]
    curve: list[EarnedValuePoint]


class WorkloadItem(BaseModel):
    project_id: int
    project_name: str
    project_code: str
    jira_key: str
    summary: str | None
    status: str
    start: dt.date | None
    finish: dt.date | None
    remaining_hours: float | None
    budget_source: str | None
    overdue: bool
    weeks: list[float]
    beyond_hours: float


class WorkloadAssignee(BaseModel):
    name: str
    weeks: list[float]
    capacity_days: list[int]
    # Dal Team del Carico team (None se la persona non c'e'): ruolo, ore al
    # giorno, ore disponibili per settimana (giorni - assenze) x ore/giorno
    # e giorni di assenza per settimana.
    role: str | None = None
    hours_per_day: float | None = None
    capacity_hours: list[float] | None = None
    absence_days: list[int] = []
    beyond_hours: float
    remaining_hours: float
    overdue_hours: float
    overdue_items: int
    undated_items: int
    unbudgeted_items: int
    items: list[WorkloadItem]


class TeamAbsence(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    start_date: dt.date
    end_date: dt.date
    kind: Literal["Ferie", "Malattia", "Altro"] = "Ferie"
    note: str | None = None


class TeamAbsenceCreate(BaseModel):
    start_date: dt.date
    end_date: dt.date
    kind: Literal["Ferie", "Malattia", "Altro"] = "Ferie"
    note: str | None = None


class TeamResource(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role_id: int
    name: str
    hours_per_day: float
    order: int
    absences: list[TeamAbsence] = []


class TeamResourceUpdate(BaseModel):
    name: str | None = None
    hours_per_day: float | None = None
    role_id: int | None = None
    order: int | None = None


class TeamRole(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    order: int
    resources: list[TeamResource] = []


class TeamRoleUpdate(BaseModel):
    name: str | None = None
    order: int | None = None


class WorkloadProject(BaseModel):
    id: int
    name: str
    code: str
    has_jql: bool
    # Ultima sync da Jira del backlog (l'item sincronizzato piu' di recente).
    last_synced_at: dt.datetime | None


class Workload(BaseModel):
    today: dt.date
    week_starts: list[dt.date]
    projects: list[WorkloadProject]
    assignees: list[WorkloadAssignee]
