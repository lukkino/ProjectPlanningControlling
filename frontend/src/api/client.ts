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
  Increment,
  IncrementBudgetLine,
  IncrementDetail,
  IncrementResourceType,
  IncrementSnapshot,
  IncrementSnapshotValue,
  OverviewMetrics,
  OverviewPeriod,
  Phase,
  PprDeliverable,
  PprDocumentMeta,
  Project,
  ProjectDetail,
  Snapshot,
  SyncResult,
  Team,
  TestConnectionResult,
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

// Scarica un file binario (es. un documento .xlsx generato dal backend),
// leggendo il nome file dall'header Content-Disposition invece di doverlo
// ricostruire lato client.
async function downloadFile(path: string, params?: Record<string, string>): Promise<{ blob: Blob; filename: string }> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : ''
  const response = await fetch(`/api${path}${qs}`)
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
  phases: {
    list: (projectId: number) => request<Phase[]>(`/projects/${projectId}/phases`),
    create: (projectId: number, data: Partial<Phase>) => post<Phase>(`/projects/${projectId}/phases`, data),
    update: (id: number, data: Partial<Phase>) => put<Phase>(`/projects/phases/${id}`, data),
    remove: (id: number) => del(`/projects/phases/${id}`),
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
  },
  incrementSnapshotValues: {
    update: (id: number, data: Partial<IncrementSnapshotValue>) =>
      put<IncrementSnapshotValue>(`/increments/snapshot-values/${id}`, data),
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
  backlog: {
    list: (projectId: number) => request<BacklogItem[]>(`/projects/${projectId}/backlog`),
    create: (projectId: number, data: Partial<BacklogItem>) =>
      post<BacklogItem>(`/projects/${projectId}/backlog`, data),
    update: (id: number, data: Partial<BacklogItem>) => put<BacklogItem>(`/backlog/${id}`, data),
    bulkUpdate: (projectId: number, data: (Partial<BacklogItem> & { id: number })[]) =>
      put<BacklogItem[]>(`/projects/${projectId}/backlog/bulk`, data),
    remove: (id: number) => del(`/backlog/${id}`),
    sync: (projectId: number) => post<SyncResult>(`/projects/${projectId}/backlog/sync`),
  },
  complaints: {
    list: () => request<Complaint[]>('/complaints'),
    update: (id: number, data: Partial<Pick<Complaint, 'salesforce_status' | 'architecture' | 'customer_site'>>) =>
      put<Complaint>(`/complaints/${id}`, data),
    sync: () => post<SyncResult>('/complaints/sync'),
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
    // Invia il documento Design Input corrente (il file .xlsx cosi' com'e',
    // come corpo binario) e riceve lo stesso file con le Story dell'increment
    // aggiunte: quante ne sono state aggiunte/saltate arriva negli header.
    designInput: async (projectId: number, file: File) => {
      const response = await fetch(
        `/api/projects/${projectId}/documents/design-input?${new URLSearchParams({ filename: file.name })}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
      )
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
      return {
        blob: await response.blob(),
        filename: match ? match[1] : file.name,
        added: Number(response.headers.get('X-Stories-Added') ?? 0),
        skipped: Number(response.headers.get('X-Stories-Skipped') ?? 0),
      }
    },
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
    ppr: (
      projectId: number,
      docType: string,
      version: number,
      revisionText: string,
      deliverables: PprDeliverable[],
    ) =>
      downloadFile(`/projects/${projectId}/documents/ppr/${docType}`, {
        version: String(version),
        revision_text: revisionText,
        deliverables: JSON.stringify(deliverables),
      }),
  },
  settings: {
    get: () => request<AppSettings>('/settings'),
    update: (data: AppSettingsUpdate) => put<AppSettings>('/settings', data),
    test: (data: AppSettingsUpdate) => post<TestConnectionResult>('/settings/test', data),
  },
}
