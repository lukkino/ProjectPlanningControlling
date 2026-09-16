import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useState } from 'react'
import { api, saveBlob } from '../api/client'
import type { ImplementedByTask, Project } from '../api/types'
import { StatusBadge } from '../components/StatusBadge'
import { useProjectContext } from './useProjectContext'

const DOCUMENT_TYPES = ['Story', 'Bug']

const PPR_TYPES: { docType: string; label: string }[] = [
  { docType: 'planning', label: 'Planning Review' },
  { docType: 'execution', label: 'Execution Review' },
  { docType: 'deployment', label: 'Deployment Review' },
  { docType: 'release-to-market', label: 'Release to Market Review' },
]

function PprDownloadButton({ projectId, docType, label }: { projectId: number; docType: string; label: string }) {
  const download = useMutation({
    mutationFn: () => api.documents.ppr(projectId, docType),
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
  })
  return (
    <button className="btn btn-primary" disabled={download.isPending} onClick={() => download.mutate()}>
      {download.isPending ? 'Generazione…' : `⬇ Scarica ${label} (.xlsx)`}
    </button>
  )
}

function ReleaseReportGenerator({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient()
  const metaQuery = useQuery({
    queryKey: ['release-report-meta', projectId],
    queryFn: () => api.documents.releaseReportMeta(projectId),
  })
  const [version, setVersion] = useState('')
  const [revisionText, setRevisionText] = useState('')
  const [touched, setTouched] = useState(false)

  // Precompila i campi con i valori proposti (versione incrementale,
  // ultimo testo di revisione) solo finche' l'utente non li ha modificati
  // a mano: dopo la generazione la query viene invalidata cosi' i valori
  // proposti ripartono aggiornati per la prossima volta.
  useEffect(() => {
    if (metaQuery.data && !touched) {
      setVersion(String(metaQuery.data.next_version))
      setRevisionText(metaQuery.data.last_revision_text)
    }
  }, [metaQuery.data, touched])

  const generate = useMutation({
    mutationFn: () => {
      const versionNumber = Number(version) || metaQuery.data?.next_version || 1
      return api.documents.releaseReport(projectId, versionNumber, revisionText)
    },
    onSuccess: ({ blob, filename }) => {
      saveBlob(blob, filename)
      setTouched(false)
      queryClient.invalidateQueries({ queryKey: ['release-report-meta', projectId] })
    },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 320, flex: 1 }}>
      <strong style={{ fontSize: 14 }}>Release Report</strong>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-row" style={{ marginBottom: 0, width: 100 }}>
          <label>Versione</label>
          <input
            type="number"
            value={version}
            onChange={(e) => {
              setVersion(e.target.value)
              setTouched(true)
            }}
          />
        </div>
        <div className="form-row" style={{ marginBottom: 0, flex: 1, minWidth: 260 }}>
          <label>Descrizione revisione</label>
          <textarea
            rows={2}
            value={revisionText}
            onChange={(e) => {
              setRevisionText(e.target.value)
              setTouched(true)
            }}
          />
        </div>
      </div>
      <div>
        <button
          className="btn btn-primary"
          disabled={!metaQuery.data || generate.isPending}
          onClick={() => generate.mutate()}
        >
          {generate.isPending ? 'Generazione…' : '⬇ Scarica Release Report (.xlsx)'}
        </button>
      </div>
      {generate.isError && <span style={{ color: 'var(--danger, #c0392b)' }}>{(generate.error as Error).message}</span>}
    </div>
  )
}

function parseImplementedBy(json: string | null): ImplementedByTask[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function DocumentsPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())

  const { data: items } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })

  const updateProject = useMutation({
    mutationFn: (data: Partial<Project>) => api.projects.update(project.id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
  })

  const downloadRegressionAnalysis = useMutation({
    mutationFn: () => api.documents.regressionAnalysis(project.id),
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
  })

  const toggleType = (type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const documentItems = (items ?? []).filter(
    (i) => i.in_scope && i.issue_type && DOCUMENT_TYPES.includes(i.issue_type) && !hiddenTypes.has(i.issue_type),
  )

  return (
    <div>
      <div className="card">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <div>
            <h3 style={{ margin: 0 }}>Documents</h3>
            <span className="sub muted">
              Story e Bug in scope del Backlog, con il parent (Epic) e i Task collegati che li implementano (link
              Jira "is implemented by").
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Change Order</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-row" style={{ marginBottom: 0, minWidth: 260, flex: 1 }}>
            <label>URL Change Order</label>
            <input
              placeholder="https://..."
              defaultValue={project.change_order_url ?? ''}
              onBlur={(e) => {
                const value = e.target.value.trim() || null
                if (value !== project.change_order_url) updateProject.mutate({ change_order_url: value })
              }}
            />
          </div>
          <div className="form-row" style={{ marginBottom: 0, minWidth: 200, flex: 1 }}>
            <label>Testo alternativo (opzionale)</label>
            <input
              placeholder="es. CO-123"
              defaultValue={project.change_order_label ?? ''}
              onBlur={(e) => {
                const value = e.target.value.trim() || null
                if (value !== project.change_order_label) updateProject.mutate({ change_order_label: value })
              }}
            />
          </div>
          {project.change_order_url && (
            <a href={project.change_order_url} target="_blank" rel="noreferrer" className="btn btn-primary">
              {project.change_order_label || project.change_order_url}
            </a>
          )}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Genera documenti</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Compila Cover e foglio dati dei template Excel ufficiali con i dati di questo progetto.
        </p>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <button
              className="btn btn-primary"
              disabled={downloadRegressionAnalysis.isPending}
              onClick={() => downloadRegressionAnalysis.mutate()}
            >
              {downloadRegressionAnalysis.isPending ? 'Generazione…' : '⬇ Scarica Regression Analysis (.xlsx)'}
            </button>
          </div>
          <ReleaseReportGenerator projectId={project.id} />
        </div>

        <p className="muted" style={{ marginTop: '1.25rem', marginBottom: '0.5rem' }}>
          Planning/Execution/Deployment/Release to Market Review: ogni documento include cumulativamente le review dei
          tipi precedenti. Viene compilata solo la Cover (titolo, firmatari, prima revisione); i fogli di review
          restano come nel template, da compilare a mano durante la riunione.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {PPR_TYPES.map(({ docType, label }) => (
            <PprDownloadButton key={docType} projectId={project.id} docType={docType} label={label} />
          ))}
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, fontSize: 13 }}>
          <span className="muted">Tipo:</span>
          {DOCUMENT_TYPES.map((type) => (
            <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={!hiddenTypes.has(type)} onChange={() => toggleType(type)} />
              {type}
            </label>
          ))}
        </div>

        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 110 }}>ID</th>
              <th>Summary</th>
              <th>Tipo</th>
              <th>Stato</th>
              <th style={{ width: 140 }}>Parent</th>
              <th style={{ width: 110 }}>Task</th>
              <th>Task Summary</th>
              <th style={{ width: 120 }}>Fix Version</th>
            </tr>
          </thead>
          <tbody>
            {documentItems.map((item) => {
              const tasks = parseImplementedBy(item.implemented_by_json)
              const rowCount = Math.max(1, tasks.length)
              return (
                <Fragment key={item.id}>
                  {Array.from({ length: rowCount }).map((_, idx) => {
                    const task = tasks[idx]
                    return (
                      <tr key={`${item.id}-${idx}`}>
                        {idx === 0 && (
                          <>
                            <td rowSpan={rowCount}>
                              <a
                                href={`https://inpeco.atlassian.net/browse/${item.jira_key}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {item.jira_key}
                              </a>
                            </td>
                            <td rowSpan={rowCount} style={{ whiteSpace: 'normal', minWidth: 260 }}>
                              {item.summary ?? <span className="muted">—</span>}
                            </td>
                            <td rowSpan={rowCount}>{item.issue_type}</td>
                            <td rowSpan={rowCount}>
                              <StatusBadge status={item.status} />
                            </td>
                            <td rowSpan={rowCount}>
                              {item.parent_key ? (
                                <a
                                  href={`https://inpeco.atlassian.net/browse/${item.parent_key}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={item.parent_summary ?? undefined}
                                >
                                  {item.parent_key}
                                </a>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          </>
                        )}
                        <td>
                          {task ? (
                            <a href={`https://inpeco.atlassian.net/browse/${task.key}`} target="_blank" rel="noreferrer">
                              {task.key}
                            </a>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'normal', minWidth: 220 }}>
                          {task ? task.summary ?? <span className="muted">—</span> : <span className="muted">—</span>}
                        </td>
                        <td>{task ? task.fix_version ?? <span className="muted">—</span> : <span className="muted">—</span>}</td>
                      </tr>
                    )
                  })}
                </Fragment>
              )
            })}
            {documentItems.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  Nessun item Story/Bug in scope trovato (o nascosto dal filtro tipo).
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
