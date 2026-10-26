import type {
  AppSettings,
  AppSettingsUpdate,
  BacklogItem,
  BugsOpenedMetrics,
  Complaint,
  ComplaintsSettings,
  CycleTimeMetrics,
  DashboardMetrics,
  DashboardSnapshotDetail,
  DashboardSnapshotSummary,
  DocumentRevisionMeta,
  ForecastSimulation,
  HoursCalculator,
  HoursDetail,
  HoursDetailRow,
  Increment,
  IncrementBudgetLine,
  IncrementDetail,
  IncrementResourceType,
  IncrementSnapshot,
  IncrementSnapshotValue,
  NonWorkingDay,
  OverviewMetrics,
  OverviewPeriod,
  Phase,
  PprDeliverable,
  PprDocumentMeta,
  PprFileRole,
  PprInspection,
  Project,
  ProjectDetail,
  ScenariosStatus,
  Snapshot,
  SubProject,
  SyncProgress,
  SyncResult,
  Team,
  TestConnectionResult,
  RequirementsCheck,
} from './types'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!response.ok) {
    let detail = response.statusText
    try {
      const body = await response.json()
      detail = body.detail ?? detail
    } catch {
      // ignore, keep statusText
    }
    throw new Error(detail)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const del = (path: string) => request<void>(path, { method: 'DELETE' })
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined })
const put = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) })

// Invia un documento .xlsx cosi' com'e' (corpo binario) e riceve lo stesso
// file con le righe dell'increment aggiunte: gli ID aggiunti e quante righe
// sono state saltate arrivano negli header "<prefisso>-Added/-Skipped", in
// "<prefisso>-Duplicates" quelle lasciate fuori perche' il documento ha gia'
// lo stesso contenuto sotto un altro ID ("NUOVO=ESISTENTE, ..."), in
// "<prefisso>-Version" la nuova versione del documento (null se la Cover non
// e' stata aggiornata), in "<prefisso>-Excluded" le eventuali voci
// dell'increment lasciate fuori, ognuna con il motivo tra parentesi, in
// "<prefisso>-Removed" le righe obsolete scritte come "Removed" nella nuova
// revisione (le righe restano nel foglio, vanno tolte a mano) e in
// "<prefisso>-Still-Present" le obsolete gia' dichiarate in una revisione
// precedente ma ancora nel foglio.
export type WorkbookExportResult = {
  blob: Blob
  filename: string
  added: string[]
  skipped: number
  duplicates: { key: string; existing: string }[]
  version: number | null
  excluded: string[]
  removed: string[]
  stillPresent: string[]
}

async function addRowsToWorkbook(path: string, file: File, headerPrefix: string): Promise<WorkbookExportResult> {
  const response = await fetch(`/api${path}?${new URLSearchParams({ filename: file.name })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  if (!response.ok) {
    let detail = response.statusText
    try {
      const body = await response.json()
      detail = body.detail ?? detail
    } catch {
      // ignore, keep statusText
    }
    throw new Error(detail)
  }
  const match = (response.headers.get('Content-Disposition') ?? '').match(/filename="?([^"]+)"?/)
  const list = (name: string) => (response.headers.get(`${headerPrefix}-${name}`) ?? '').split(', ').filter(Boolean)
  return {
    blob: await response.blob(),
    filename: match ? match[1] : file.name,
    added: list('Added'),
    skipped: Number(response.headers.get(`${headerPrefix}-Skipped`) ?? 0),
    duplicates: list('Duplicates').map((pair) => {
      const [key, existing] = pair.split('=')
      return { key, existing }
    }),
    version: Number(response.headers.get(`${headerPrefix}-Version`)) || null,
    excluded: list('Excluded'),
    removed: list('Removed'),
    stillPresent: list('Still-Present'),
  }
}

const checkWorkbook = (projectId: number, document: string, file: File) =>
  request<RequirementsCheck>(`/projects/${projectId}/documents/${document}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })

// Scarica un file binario (es. un documento .xlsx generato dal backend),
// leggendo il nome file dall'header Content-Disposition invece di doverlo
// ricostruire lato client.
async function downloadFile(
  path: string,
  params?: Record<string, string>,
  init?: RequestInit,
): Promise<{ blob: Blob; filename: string }> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : ''
  const response = await fetch(`/api${path}${qs}`, init)
  if (!response.ok) {
    let detail = response.statusText
    try {
      const body = await response.json()
      detail = body.detail ?? detail
    } catch {
      // ignore, keep statusText
    }
    throw new Error(detail)
  }
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename="?([^"]+)"?/)
  const filename = match ? match[1] : 'download.xlsx'
  const blob = await response.blob()
  return { blob, filename }
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export const api = {
  projects: {
    list: () => request<Project[]>('/projects'),
    get: (id: number) => request<ProjectDetail>(`/projects/${id}`),
    create: (data: Partial<Project>) => post<ProjectDetail>('/projects', data),
    update: (id: number, data: Partial<Project>) => put<ProjectDetail>(`/projects/${id}`, data),
    remove: (id: number) => del(`/projects/${id}`),
    setGanttOrder: (projectIds: number[]) => put<void>('/projects/gantt-order', { project_ids: projectIds }),
  },
  increments: {
    list: () => request<Increment[]>('/increments'),
    get: (id: number) => request<IncrementDetail>(`/increments/${id}`),
    create: (data: Partial<Increment>) => post<Increment>('/increments', data),
    update: (id: number, data: Partial<Increment>) => put<Increment>(`/increments/${id}`, data),
    remove: (id: number) => del(`/increments/${id}`),
  },
  subProjects: {
    create: (incrementId: number, data: Pick<SubProject, 'name' | 'budget_hours' | 'order'>) =>
      post<SubProject>(`/increments/${incrementId}/sub-projects`, data),
    update: (id: number, data: Partial<Pick<SubProject, 'name' | 'budget_hours' | 'project_id'>>) =>
      put<SubProject>(`/increments/sub-projects/${id}`, data),
    remove: (id: number) => del(`/increments/sub-projects/${id}`),
  },
  phases: {
    list: (projectId: number) => request<Phase[]>(`/projects/${projectId}/phases`),
    create: (projectId: number, data: Partial<Phase>) => post<Phase>(`/projects/${projectId}/phases`, data),
    update: (id: number, data: Partial<Phase>) => put<Phase>(`/projects/phases/${id}`, data),
    remove: (id: number) => del(`/projects/phases/${id}`),
  },
  nonWorkingDays: {
    list: (projectId: number) => request<NonWorkingDay[]>(`/projects/${projectId}/non-working-days`),
    create: (projectId: number, data: Pick<NonWorkingDay, 'start_date' | 'end_date' | 'description'>) =>
      post<NonWorkingDay>(`/projects/${projectId}/non-working-days`, data),
    remove: (id: number) => del(`/projects/non-working-days/${id}`),
  },
  incrementBudgetLines: {
    list: (incrementId: number) => request<IncrementBudgetLine[]>(`/increments/${incrementId}/budget-lines`),
    create: (incrementId: number, data: Partial<IncrementBudgetLine>) =>
      post<IncrementBudgetLine>(`/increments/${incrementId}/budget-lines`, data),
    update: (id: number, data: Partial<IncrementBudgetLine>) =>
      put<IncrementBudgetLine>(`/increments/budget-lines/${id}`, data),
    remove: (id: number) => del(`/increments/budget-lines/${id}`),
  },
  incrementSnapshots: {
    list: (incrementId: number) => request<IncrementSnapshot[]>(`/increments/${incrementId}/snapshots`),
    create: (incrementId: number, data: { snapshot_date: string; note?: string | null }) =>
      post<IncrementSnapshot>(`/increments/${incrementId}/snapshots`, data),
    update: (id: number, data: Partial<IncrementSnapshot>) =>
      put<IncrementSnapshot>(`/increments/snapshots/${id}`, data),
    remove: (id: number) => del(`/increments/snapshots/${id}`),
    setSubProjectHours: (snapshotId: number, subProjectId: number, actualHours: number) =>
      put<{ sub_project_id: number; actual_hours: number }>(
        `/increments/snapshots/${snapshotId}/sub-projects/${subProjectId}`,
        { actual_hours: actualHours },
      ),
  },
  incrementSnapshotValues: {
    update: (id: number, data: Partial<IncrementSnapshotValue>) =>
      put<IncrementSnapshotValue>(`/increments/snapshot-values/${id}`, data),
    // Ripartizione dell'Actual ore (Project Management, Develop, ...): ogni
    // chiamata restituisce il valore con l'Actual ricalcolato.
    split: (valueId: number) => post<IncrementSnapshotValue>(`/increments/snapshot-values/${valueId}/split`),
    removeSplit: (valueId: number) =>
      request<IncrementSnapshotValue>(`/increments/snapshot-values/${valueId}/split`, { method: 'DELETE' }),
    setEntryHours: (entryId: number, hours: number) =>
      put<IncrementSnapshotValue>(`/increments/snapshot-value-entries/${entryId}`, { hours }),
  },
  hoursCalculator: {
    get: (incrementId: number) => request<HoursCalculator>(`/increments/${incrementId}/hours-calculator`),
    update: (incrementId: number, data: Partial<Omit<HoursCalculator, 'resource_types'>>) =>
      put<HoursCalculator>(`/increments/${incrementId}/hours-calculator`, data),
    addResourceType: (incrementId: number, data: Partial<IncrementResourceType>) =>
      post<IncrementResourceType>(`/increments/${incrementId}/resource-types`, data),
    updateResourceType: (id: number, data: Partial<IncrementResourceType>) =>
      put<IncrementResourceType>(`/increments/resource-types/${id}`, data),
    removeResourceType: (id: number) => del(`/increments/resource-types/${id}`),
  },
  hoursDetail: {
    get: (incrementId: number) => request<HoursDetail>(`/increments/${incrementId}/hours-detail`),
    // "Aggiorna ore progetto": le righe diventano le tipologie del calcolatore.
    setRows: (incrementId: number, rows: Pick<HoursDetailRow, 'name' | 'resource_count' | 'hours'>[]) =>
      put<HoursDetail>(`/increments/${incrementId}/hours-detail/rows`, rows),
    // Ore di una riga corrette a mano (es. arrotondate).
    setRowHours: (rowId: number, hours: number) => put<HoursDetail>(`/increments/hours-detail/rows/${rowId}`, { hours }),
    addReview: (incrementId: number) => post<HoursDetail>(`/increments/${incrementId}/hours-detail/reviews`),
    renameReview: (reviewId: number, name: string) =>
      put<HoursDetail>(`/increments/hours-detail/reviews/${reviewId}`, { name }),
    removeReview: (reviewId: number) => del(`/increments/hours-detail/reviews/${reviewId}`),
    // hours null = svuota la cella.
    setReviewHours: (reviewId: number, rowId: number, hours: number | null) =>
      put<HoursDetail>(`/increments/hours-detail/reviews/${reviewId}/rows/${rowId}`, { hours }),
  },
  backlog: {
    list: (projectId: number) => request<BacklogItem[]>(`/projects/${projectId}/backlog`),
    create: (projectId: number, data: Partial<BacklogItem>) =>
      post<BacklogItem>(`/projects/${projectId}/backlog`, data),
    update: (id: number, data: Partial<BacklogItem>) => put<BacklogItem>(`/backlog/${id}`, data),
    bulkUpdate: (projectId: number, data: (Partial<BacklogItem> & { id: number })[]) =>
      put<BacklogItem[]>(`/projects/${projectId}/backlog/bulk`, data),
    remove: (id: number) => del(`/backlog/${id}`),
    sync: (projectId: number) => post<SyncResult>(`/projects/${projectId}/backlog/sync`),
    syncProgress: (projectId: number) => request<SyncProgress>(`/projects/${projectId}/backlog/sync/progress`),
  },
  scenarios: {
    status: (projectId: number) => request<ScenariosStatus>(`/projects/${projectId}/scenarios`),
    create: (itemId: number) => post<{ filename: string }>(`/backlog/${itemId}/scenarios`),
    // Apre il pptx in PowerPoint sulla macchina del backend (quella
    // dell'utente): un link file:// verrebbe bloccato dal browser.
    open: (itemId: number) => post<void>(`/backlog/${itemId}/scenarios/open`),
    // Finestra "Apri file" di Windows aperta dal backend: path null se
    // chiusa senza scegliere.
    browse: (projectId: number) => post<{ path: string | null }>(`/projects/${projectId}/scenarios/browse`),
  },
  complaints: {
    list: () => request<Complaint[]>('/complaints'),
    update: (id: number, data: Partial<Pick<Complaint, 'salesforce_status' | 'architecture' | 'customer_site'>>) =>
      put<Complaint>(`/complaints/${id}`, data),
    sync: () => post<SyncResult>('/complaints/sync'),
    syncProgress: () => request<SyncProgress>('/complaints/sync/progress'),
    // Tutti i complaint in un file Excel, con le intestazioni filtrabili.
    exportExcel: () => downloadFile('/complaints/export'),
    getSettings: () => request<ComplaintsSettings>('/complaints/settings'),
    updateSettings: (data: ComplaintsSettings) => put<ComplaintsSettings>('/complaints/settings', data),
  },
  snapshots: {
    list: (projectId: number) => request<Snapshot[]>(`/projects/${projectId}/snapshots`),
    create: (projectId: number, data: Partial<Snapshot>) =>
      post<Snapshot>(`/projects/${projectId}/snapshots`, data),
    update: (id: number, data: Partial<Snapshot>) => put<Snapshot>(`/snapshots/${id}`, data),
    remove: (id: number) => del(`/snapshots/${id}`),
  },
  dashboard: {
    get: (projectId: number) => request<DashboardMetrics>(`/projects/${projectId}/dashboard`),
    // Presentazione .pptx della Dashboard increment; closedDays e' il periodo
    // selezionato nella card delle issue chiuse.
    presentation: (projectId: number, closedDays: number) =>
      downloadFile(`/projects/${projectId}/dashboard/presentation`, { days: String(closedDays) }),
    overview: (team: Team, period: OverviewPeriod = 'current') =>
      request<OverviewMetrics>(`/dashboard/overview?team=${team}&period=${period}`),
    cycleTime: (team: Team) => request<CycleTimeMetrics>(`/dashboard/cycle-time?team=${team}`),
    cycleTimeProgress: (team: Team) => request<SyncProgress>(`/dashboard/cycle-time/progress?team=${team}`),
    bugsOpened: (team: Team) => request<BugsOpenedMetrics>(`/dashboard/bugs-opened?team=${team}`),
  },
  dashboardSnapshots: {
    list: () => request<DashboardSnapshotSummary[]>('/dashboard/snapshots'),
    get: (id: number) => request<DashboardSnapshotDetail>(`/dashboard/snapshots/${id}`),
    create: (note: string | null) => post<DashboardSnapshotSummary>('/dashboard/snapshots', { note }),
    update: (id: number, note: string | null) => put<DashboardSnapshotSummary>(`/dashboard/snapshots/${id}`, { note }),
    remove: (id: number) => del(`/dashboard/snapshots/${id}`),
  },
  forecasting: {
    list: (projectId: number) => request<ForecastSimulation[]>(`/projects/${projectId}/forecasting`),
    create: (projectId: number, data: Partial<ForecastSimulation>) =>
      post<ForecastSimulation>(`/projects/${projectId}/forecasting`, data),
    update: (id: number, data: Partial<ForecastSimulation>) => put<ForecastSimulation>(`/forecasting/${id}`, data),
    remove: (id: number) => del(`/forecasting/${id}`),
  },
  documents: {
    // Presentazione di Kick-off (.pptx) dal template ufficiale.
    kickoffPresentation: (projectId: number) =>
      downloadFile(`/projects/${projectId}/documents/kickoff-presentation`),
    // Design Input (TIH-DI) e User Needs (TIH-UN): vedi addRowsToWorkbook.
    designInput: (projectId: number, file: File) =>
      addRowsToWorkbook(`/projects/${projectId}/documents/design-input`, file, 'X-Stories'),
    userNeeds: (projectId: number, file: File) =>
      addRowsToWorkbook(`/projects/${projectId}/documents/user-needs`, file, 'X-User-Needs'),
    // Confronta il documento (Design Input o User Needs) con Jira: il file non
    // viene modificato.
    designInputCheck: (projectId: number, file: File) => checkWorkbook(projectId, 'design-input', file),
    userNeedsCheck: (projectId: number, file: File) => checkWorkbook(projectId, 'user-needs', file),
    regressionAnalysisMeta: (projectId: number) =>
      request<DocumentRevisionMeta>(`/projects/${projectId}/documents/regression-analysis/meta`),
    regressionAnalysis: (projectId: number, version: number, revisionText: string) =>
      downloadFile(`/projects/${projectId}/documents/regression-analysis`, {
        version: String(version),
        revision_text: revisionText,
      }),
    releaseReportMeta: (projectId: number) =>
      request<DocumentRevisionMeta>(`/projects/${projectId}/documents/release-report/meta`),
    releaseReport: (projectId: number, version: number, revisionText: string) =>
      downloadFile(`/projects/${projectId}/documents/release-report`, {
        version: String(version),
        revision_text: revisionText,
      }),
    pprMeta: (projectId: number, docType: string) =>
      request<PprDocumentMeta>(`/projects/${projectId}/documents/ppr/${docType}/meta`),
    // Documenti PPR precedenti in base64 (vedi PprDownloadButton): niente
    // viene salvato sul server.
    pprInspect: (projectId: number, docType: string, role: PprFileRole, fileB64: string) =>
      post<PprInspection>(`/projects/${projectId}/documents/ppr/${docType}/inspect`, { role, file_b64: fileB64 }),
    ppr: (
      projectId: number,
      docType: string,
      data: {
        version: number
        revision_text: string
        deliverables: PprDeliverable[] | null
        previous_b64: string | null
        previous_phase_b64: string | null
      },
    ) =>
      downloadFile(`/projects/${projectId}/documents/ppr/${docType}`, undefined, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    // Elenco dei documenti attesi alla review con gli owner (.txt), non per il Planning.
    pprDeliverablesTxt: (projectId: number, docType: string) =>
      downloadFile(`/projects/${projectId}/documents/ppr/${docType}/deliverables-txt`),
  },
  settings: {
    get: () => request<AppSettings>('/settings'),
    update: (data: AppSettingsUpdate) => put<AppSettings>('/settings', data),
    test: (data: AppSettingsUpdate) => post<TestConnectionResult>('/settings/test', data),
  },
}
