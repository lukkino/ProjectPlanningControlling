import type {
  BacklogItem,
  BudgetLine,
  DashboardMetrics,
  DocumentRevisionMeta,
  ForecastSimulation,
  Phase,
  Project,
  ProjectDetail,
  Snapshot,
  SyncResult,
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
  },
  phases: {
    list: (projectId: number) => request<Phase[]>(`/projects/${projectId}/phases`),
    create: (projectId: number, data: Partial<Phase>) => post<Phase>(`/projects/${projectId}/phases`, data),
    update: (id: number, data: Partial<Phase>) => put<Phase>(`/projects/phases/${id}`, data),
    remove: (id: number) => del(`/projects/phases/${id}`),
  },
  budgetLines: {
    list: (projectId: number) => request<BudgetLine[]>(`/projects/${projectId}/budget-lines`),
    create: (projectId: number, data: Partial<BudgetLine>) =>
      post<BudgetLine>(`/projects/${projectId}/budget-lines`, data),
    update: (id: number, data: Partial<BudgetLine>) => put<BudgetLine>(`/projects/budget-lines/${id}`, data),
    remove: (id: number) => del(`/projects/budget-lines/${id}`),
  },
  backlog: {
    list: (projectId: number) => request<BacklogItem[]>(`/projects/${projectId}/backlog`),
    create: (projectId: number, data: Partial<BacklogItem>) =>
      post<BacklogItem>(`/projects/${projectId}/backlog`, data),
    update: (id: number, data: Partial<BacklogItem>) => put<BacklogItem>(`/backlog/${id}`, data),
    remove: (id: number) => del(`/backlog/${id}`),
    sync: (projectId: number) => post<SyncResult>(`/projects/${projectId}/backlog/sync`),
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
  },
  forecasting: {
    list: (projectId: number) => request<ForecastSimulation[]>(`/projects/${projectId}/forecasting`),
    create: (projectId: number, data: Partial<ForecastSimulation>) =>
      post<ForecastSimulation>(`/projects/${projectId}/forecasting`, data),
    update: (id: number, data: Partial<ForecastSimulation>) => put<ForecastSimulation>(`/forecasting/${id}`, data),
    remove: (id: number) => del(`/forecasting/${id}`),
  },
  documents: {
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
      request<DocumentRevisionMeta>(`/projects/${projectId}/documents/ppr/${docType}/meta`),
    ppr: (projectId: number, docType: string, version: number, revisionText: string) =>
      downloadFile(`/projects/${projectId}/documents/ppr/${docType}`, {
        version: String(version),
        revision_text: revisionText,
      }),
  },
}
