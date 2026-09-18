export type Phase = {
  id: number
  project_id: number
  name: string
  planned_date: string | null
  actual_date: string | null
  order: number
  notes: string | null
}

export type IncrementBudgetLine = {
  id: number
  increment_id: number
  role_name: string
  budget_hours: number
  order: number
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
  issue_type: string | null
  jira_status: string | null
  labels: string | null
  parent_key: string | null
  parent_summary: string | null
  implemented_by_json: string | null
  last_synced_at: string | null
  ready_for_refinement: boolean
  in_scope: boolean
  included_in_codefreeze: boolean
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
  status: 'To Do' | 'In Progress' | 'Done'
}

export type SyncResult = {
  created: number
  updated: number
  total_matched: number
  errors: string[]
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
  created_at: string
  updated_at: string
}

export type Increment = {
  id: number
  code: string
  notes: string | null
  start_date: string | null
  end_date: string | null
  estimated_budget_hours: number
  estimated_budget_material: number
  project_id: number | null
  created_at: string
  updated_at: string
}

export type ProjectDetail = Project & {
  phases: Phase[]
  // Progetti (budget/rendicontazione) collegati a questo rilascio: un
  // rilascio puo' averne piu' di uno (vedi Increment.project_id).
  progetti: Increment[]
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
  logged_hours_total: number
  dev_logged_hours_total: number
  percent_budget_used: number
  budget_lines: IncrementBudgetLine[]
}

export type DocumentRevisionMeta = {
  next_version: number
  last_revision_text: string
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

export type DashboardMetrics = {
  backlog_total: number
  backlog_in_scope: number
  backlog_done: number
  percent_complete: number
  logged_hours_total: number
  dev_logged_hours_total: number
  percent_time_elapsed: number | null
  spi: number | null
  completion_source: 'backlog' | 'snapshot'
  logged_hours_source: 'backlog' | 'snapshot'
  last_snapshot_date: string | null
  phases: Phase[]
}
