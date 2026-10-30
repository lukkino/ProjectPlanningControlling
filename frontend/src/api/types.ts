// Giorni non lavorativi del team (ferie, malattia, chiusure), estremi
// compresi: la pianificazione del Backlog li salta come i weekend.
export type NonWorkingDay = {
  id: number
  project_id: number
  start_date: string
  end_date: string
  description: string | null
}

export type Phase = {
  id: number
  project_id: number
  name: string
  // Originale (baseline), pianificata aggiornata (quella che vale ora) ed
  // effettiva; changes = storico dei cambi della pianificata aggiornata.
  original_date: string | null
  planned_date: string | null
  actual_date: string | null
  order: number
  notes: string | null
  changes: PhaseDateChange[]
}

export type PhaseDateChange = {
  id: number
  old_date: string | null
  new_date: string | null
  changed_at: string
}

export type IncrementBudgetLine = {
  id: number
  increment_id: number
  category_name: string
  is_hours: boolean
  order: number
}

export type IncrementSnapshotValue = {
  id: number
  budget_line_id: number
  budget_value: number
  actual_value: number
  // Ripartizione dell'Actual (voci in ore: Project Management, Develop,
  // ...): se presente, actual_value ne e' la somma, calcolata dal backend.
  entries: IncrementSnapshotValueEntry[]
}

export type IncrementSnapshotValueEntry = {
  id: number
  name: string
  hours: number
}

export type IncrementSnapshot = {
  id: number
  increment_id: number
  snapshot_date: string
  note: string | null
  values: IncrementSnapshotValue[]
  // Actual ore dei sotto-progetti del progetto (cumulativo ad oggi): solo
  // quelli gia' inseriti, chi manca vale 0.
  sub_values: { sub_project_id: number; actual_hours: number }[]
}

// Calcolatore ore progetto: una tipologia di risorsa ("DEV") con quante
// risorse lavorano sul progetto e quante ore effettive al giorno ciascuna.
export type IncrementResourceType = {
  id: number
  increment_id: number
  name: string
  resource_count: number
  hours_per_day: number
  order: number
  // Persone della tipologia (composizione del team di progetto): se ce ne
  // sono, le ore della tipologia sono la somma delle loro.
  members: TeamMember[]
}

// Una persona del team, con le ore disponibili al giorno e le ferie.
export type TeamMember = {
  id: number
  resource_type_id: number
  name: string
  hours_per_day: number
  order: number
  absences: MemberAbsence[]
}

export type AbsenceKind = 'Ferie' | 'Malattia' | 'Altro'

// Assenza di una persona: dal primo all'ultimo giorno compresi (ISO
// yyyy-mm-dd). Il tipo e' solo informativo: tutte tolgono ore.
export type MemberAbsence = {
  id: number
  member_id: number
  start_date: string
  end_date: string
  kind: AbsenceKind
  note: string | null
}

export type HoursCalculator = {
  // null = non impostata: si usa la data corrispondente del progetto.
  start_date: string | null
  end_date: string | null
  vacation_days: number
  resource_types: IncrementResourceType[]
}

// Dettaglio budget ore progetto: le ore per tipologia di risorsa copiate dal
// calcolatore ("Aggiorna ore progetto") e le colonne di revisione.
export type HoursDetailRow = {
  id: number
  name: string
  resource_count: number
  hours: number
  // Ore per revisione: chiave = id della revisione; manca se non inserite.
  review_hours: Record<number, number>
}

export type HoursReview = {
  id: number
  name: string
  order: number
}

export type HoursDetail = {
  rows: HoursDetailRow[]
  reviews: HoursReview[]
}

export type ImplementedByTask = {
  key: string
  summary: string | null
  fix_version: string | null
}

export type BacklogItem = {
  id: number
  project_id: number
  jira_key: string
  priority_order: number
  summary: string | null
  dev_effort_hours: number | null
  impacts_on: string | null
  // Assegnatario Jira (nome visualizzato); null se non assegnata.
  assignee: string | null
  issue_type: string | null
  jira_status: string | null
  labels: string | null
  parent_key: string | null
  parent_summary: string | null
  implemented_by_json: string | null
  last_synced_at: string | null
  // Quando la sync non ha piu' trovato l'item nella JQL; null = nel backlog.
  archived_at: string | null
  ready_for_refinement: boolean
  in_scope: boolean
  included_in_codefreeze: boolean
  // Attivita' di servizio: fuori dal code freeze ma visibile in tabella e
  // nel Gantt, fuori dalla cascata. Implica included_in_codefreeze=false.
  is_activity: boolean
  // Presentazione degli scenari collegata a mano (percorso di un file o
  // URL); se manca vale quella trovata nella cartella Scenarios.
  scenarios_link: string | null
  planned: boolean
  planned_duration_days: number | null
  dev_estimate_hours: number | null
  test_estimate_hours: number | null
  planned_hours: number | null
  planned_start: string | null
  expected_finish: string | null
  actual_start: string | null
  actual_finish: string | null
  logged_hours: number | null
  refinement_date: string | null
  ta_date: string | null
  notes: string | null
  progetto_id: number | null
  // Chiavi Jira dei predecessori, separate da virgola (vedi lib/scheduling.ts).
  predecessors: string | null
  status: 'To Do' | 'In Progress' | 'Done'
}

export type SyncResult = {
  created: number
  updated: number
  removed: number
  // Backlog: item archiviati tornati perche' rientrati nella JQL.
  restored: number
  total_matched: number
  errors: string[]
}

// Una cartella dell'increment (es. quella dei documenti delle review): null
// se non impostata; folder_exists se c'e' davvero su file system.
export type FolderStatus = {
  folder: string | null
  folder_exists: boolean
}

// Documento PPR della cartella review proposto nel popup come documento
// precedente: info se e' del tipo giusto, altrimenti error col motivo.
export type PprCandidate = {
  filename: string
  modified: string
  info: PprInspection | null
  error: string | null
}

// Presentazioni degli scenari delle Story nella cartella Scenarios
// dell'increment: files va da chiave Jira a nome del file pptx.
export type ScenariosStatus = {
  folder: string | null
  folder_exists: boolean
  files: Record<string, string>
}

// Avanzamento della sync Backlog in corso (vedi SyncProgress nel backend).
export type SyncProgress = {
  phase: 'idle' | 'search' | 'changelog' | 'details' | 'saving'
  done: number
  total: number
}

export type Snapshot = {
  id: number
  project_id: number
  snapshot_date: string
  actual_hours: number | null
  logged_hours: number | null
  pbi_total: number | null
  pbi_done: number | null
  note: string | null
}

export type ForecastSimulation = {
  id: number
  project_id: number
  note: string | null
  simulation_date: string | null
  pbi_remaining: number | null
  pbi_done: number | null
  planned_pbi_done: number | null
  unplanned_pbi_done: number | null
  planned_pbi_keys: string | null
  unplanned_pbi_keys: string | null
  traditional_forecasting: string | null
  code_freeze_deadline: string | null
  completion_likelihood: number | null
  completion_date_85pct: string | null
  pbi_completed_by_deadline_85pct: number | null
  completion_date_85pct_with_holidays: string | null
  // JSON dei parametri Monte Carlo usati per le previsioni (vedi
  // lib/forecastParams): null per le righe inserite a mano.
  mc_params: string | null
}

export type Project = {
  id: number
  code: string
  name: string
  status: string
  scope: string | null
  start_date: string | null
  code_freeze_date: string | null
  planned_finish_date: string | null
  dev_start_date: string | null
  jira_jql: string | null
  change_order_url: string | null
  change_order_label: string | null
  // Percorsi delle cartelle (create a mano su file system) per gli scenari
  // delle Story e per i documenti delle review.
  scenarios_folder: string | null
  review_documents_folder: string | null
  is_current: boolean
  // Data di rilascio: valorizzata = increment "Rilasciato".
  release_date: string | null
  // Posizione nel Gantt della Dashboard generale in ordinamento Manuale
  // (null = mai riordinato a mano).
  gantt_order: number | null
  created_at: string
  updated_at: string
}

// Sotto-progetto di un progetto, con un suo budget ore: si collega a un
// increment per conto suo, per i progetti che non vanno per intero su un
// solo increment (es. una maintenance divisa tra piu' increment).
export type SubProject = {
  id: number
  increment_id: number
  // Codice del progetto di cui fa parte (es. "PTIH-MA26").
  increment_code: string
  name: string
  budget_hours: number
  // Ore usate: l'Actual nell'ultimo snapshot dello Storico del progetto.
  actual_hours: number
  // Increment (Project) su cui rendiconta le ore, se collegato.
  project_id: number | null
  order: number
}

export type Increment = {
  id: number
  code: string
  notes: string | null
  start_date: string | null
  end_date: string | null
  estimated_budget_hours: number
  estimated_budget_material: number
  // Increment (Project) a cui il progetto e' collegato per intero; null
  // anche quando e' collegato tramite i sotto-progetti.
  project_id: number | null
  created_at: string
  updated_at: string
  sub_projects: SubProject[]
}

export type ProjectDetail = Project & {
  phases: Phase[]
  // Progetti (budget/rendicontazione) collegati a questo rilascio: un
  // rilascio puo' averne piu' di uno (vedi Increment.project_id).
  progetti: Increment[]
  // Sotto-progetti collegati a questo rilascio, di progetti non collegati
  // per intero.
  sub_projects: SubProject[]
}

export type IncrementDetail = Increment & {
  // Il rilascio (Project) a cui questo progetto rendiconta le ore, se
  // assegnato: un progetto appartiene al massimo a un Project.
  project: Project | null
  backlog_total: number
  backlog_in_scope: number
  backlog_done: number
  percent_complete: number
  budget_hours_total: number
  budget_material_total: number
  logged_hours_total: number
  actual_material_total: number
  dev_logged_hours_total: number
  percent_budget_used: number
  percent_material_used: number
  budget_lines: IncrementBudgetLine[]
  snapshots: IncrementSnapshot[]
}

export type DocumentRevisionMeta = {
  next_version: number
  last_revision_text: string
}

export type RequirementCheckItem = {
  key: string
  summary: string
  status: string
  category: string
  expanded_by: string[]
  current_increment: boolean
}

// Confronto tra un foglio di requisiti di un documento ("User Needs" o
// "Design Input - Stories") e le issue corrispondenti su Jira.
export type RequirementsCheck = {
  jira_project: string
  document_count: number
  jira_valid_count: number
  jira_obsolete_count: number
  missing: RequirementCheckItem[]
  obsolete_in_document: RequirementCheckItem[]
  not_done_in_document: RequirementCheckItem[]
  wrong_category_in_document: RequirementCheckItem[]
  unknown_in_document: string[]
  repeated_in_document: string[]
}

export type PprDeliverable = {
  row: number
  name: string
  included: boolean
  filename: string
  notes: string
}

export type PprDocumentMeta = DocumentRevisionMeta & {
  deliverables: PprDeliverable[]
}

// Documento PPR caricato nel popup: "previous" = ultima versione dello
// stesso documento, "previous_phase" = ultimo documento della fase precedente.
export type PprFileRole = 'previous' | 'previous_phase'

export type PprInspection = {
  title: string
  last_version: number | null
  last_description: string | null
  // Solo per l'ultimo Planning: i Deliverable Check gia' compilati.
  deliverables: PprDeliverable[] | null
  // Documento col vecchio template: se ne usano solo versione e history.
  old_template: boolean
}

export type DashboardMetrics = {
  backlog_total: number
  backlog_in_scope: number
  backlog_done: number
  percent_complete: number
  logged_hours_total: number
  dev_logged_hours_total: number
  // Somma dei budget ore dei progetti collegati (0 se non ce ne sono) e
  // quota gia' consumata dalle ore usate (null senza budget).
  budget_hours_total: number
  percent_budget_used: number | null
  percent_time_elapsed: number | null
  spi: number | null
  completion_source: 'backlog' | 'snapshot'
  // 'progetti': somma delle ore usate dei progetti e sotto-progetti collegati.
  logged_hours_source: 'backlog' | 'snapshot' | 'progetti'
  last_snapshot_date: string | null
  phases: Phase[]
}

// Team a cui sono assegnati i PBI: JQL base diversa (issuetype/label) per
// ciascuno, configurata in Configurazione - vedi AppSettings.team_*_base_jql.
export type Team = 'sw' | 'embedded'

export type PbiDoneCount = {
  issue_type: string
  count: number
}

// Finestra del grafico Metriche: ultimi 365 giorni o i 365 precedenti.
export type OverviewPeriod = 'current' | 'previous'

export type OverviewMetrics = {
  done_last_12_months: PbiDoneCount[]
  done_last_12_months_total: number
  story_enhancement_count: number
  bug_complaint_count: number
  bug_cve_count: number
  error: string | null
}

export type CycleTimePoint = {
  key: string
  issue_type: string
  finish_date: string
  cycle_time_days: number
  is_cve: boolean
}

export type BugsOpenedMonth = {
  month: string
  complaint: number
  non_complaint: number
  cve: number
}

export type BugStatusCount = {
  status: string
  count: number
}

export type BugsOpenedMetrics = {
  months: BugsOpenedMonth[]
  by_status: BugStatusCount[]
  error: string | null
}

export type CycleTimeMetrics = {
  points: CycleTimePoint[]
  p50: number | null
  p85: number | null
  p95: number | null
  error: string | null
  // Quando i dati sono stati estratti da Jira (UTC, senza fuso: vedi
  // parseBackendDateTime).
  fetched_at: string | null
}

export type AppSettings = {
  jira_base_url: string | null
  jira_email: string | null
  jira_api_token_set: boolean
  jira_api_token_preview: string | null
  // Jira non la espone via API: inserita a mano, solo per l'avviso in UI.
  jira_api_token_expires_at: string | null
  // JQL base (project/issuetype/label, senza status/finestra temporale ne'
  // AND finale, aggiunti dal backend) per i grafici della Dashboard
  // generale (Metriche, Cycle Time, Throughput), una per team.
  team_sw_base_jql: string | null
  team_embedded_base_jql: string | null
}

export type AppSettingsUpdate = {
  jira_base_url?: string | null
  jira_email?: string | null
  // Vuoto/omesso = lascia invariato il token esistente lato backend.
  jira_api_token?: string
  jira_api_token_expires_at?: string | null
  team_sw_base_jql?: string | null
  team_embedded_base_jql?: string | null
}

export type TestConnectionResult = {
  ok: boolean
  message: string
}

// Snapshot della Dashboard generale: i dati dei grafici Jira di entrambi i
// team congelati in un giorno preciso (vedi models.DashboardSnapshot).
export type DashboardSnapshotTeamData = {
  overview_current: OverviewMetrics
  overview_previous: OverviewMetrics
  cycle_time: CycleTimeMetrics
  bugs_opened: BugsOpenedMetrics
}

export type DashboardSnapshotSummary = {
  id: number
  snapshot_date: string
  created_at: string
  note: string | null
  has_errors: boolean
}

export type DashboardSnapshotDetail = DashboardSnapshotSummary & {
  teams: Partial<Record<Team, DashboardSnapshotTeamData>>
}

export type SalesforceStatus = 'Aperto' | 'Chiuso'

// Un complaint: Bug Jira nato da un case Salesforce (vedi models.Complaint).
export type Complaint = {
  id: number
  jira_key: string
  summary: string | null
  jira_status: string | null
  // Campo Jira "Fix versions": piu' d'una separate da ", "; null se non
  // valorizzato.
  fix_versions: string | null
  // Campo Jira "Severity" (High/Medium/Low); null se non valorizzato.
  severity: string | null
  jira_created: string | null
  // Data di chiusura su Jira (stato Done, Rejected...); null se ancora aperto.
  jira_resolved: string | null
  labels: string | null
  // Label di architettura (Legacy/NA5/NA6/NA7); piu' d'una separate da ", ".
  architecture: string | null
  // true = impostata a mano, la sync non la ricalcola dalle label Jira.
  architecture_manual: boolean
  salesforce_case_number: string | null
  salesforce_case_id: string | null
  // Non esiste in Jira: gestito a mano, la sync non lo tocca.
  salesforce_status: SalesforceStatus
  customer_site: string | null
  // true = corretto a mano, la sync non lo ricalcola dalle label Jira.
  customer_site_manual: boolean
  // Activity Jira con i dettagli del TSB che risolve il bug (link "relates
  // to" con TSB nel summary).
  tsb_activities: { key: string; summary: string; status: string | null }[]
  last_synced_at: string | null
}

export type ComplaintsSettings = {
  base_jql: string
}
