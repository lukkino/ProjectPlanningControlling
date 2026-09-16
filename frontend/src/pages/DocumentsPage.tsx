import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { api, saveBlob } from '../api/client'
import type { DocumentRevisionMeta, ImplementedByTask, Project } from '../api/types'
import { StatusBadge } from '../components/StatusBadge'
import { useProjectContext } from './useProjectContext'

const DOCUMENT_TYPES = ['Story', 'Bug']

const PPR_TYPES: { docType: string; label: string }[] = [
  { docType: 'planning', label: 'Planning Review' },
  { docType: 'execution', label: 'Execution Review' },
  { docType: 'deployment', label: 'Deployment Review' },
  { docType: 'release-to-market', label: 'Release to Market Review' },
]

// Popup unico (stessa UI per tutti i documenti generati) per inserire
// versione e testo di revisione prima del download: i valori proposti
// (loadMeta) arrivano freschi dal backend ogni volta che si apre, cosi'
// riflettono l'eventuale ultima generazione fatta (es. la RR incrementa il
// proprio contatore lato server).
function DocumentDownloadButton({
  label,
  loadMeta,
  download,
}: {
  label: string
  loadMeta: () => Promise<DocumentRevisionMeta>
  download: (version: number, revisionText: string) => Promise<{ blob: Blob; filename: string }>
}) {
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [revisionText, setRevisionText] = useState('')

  const prepare = useMutation({
    mutationFn: loadMeta,
    onSuccess: (meta) => {
      setVersion(String(meta.next_version))
      setRevisionText(meta.last_revision_text)
      setOpen(true)
    },
  })

  const confirm = useMutation({
    mutationFn: () => download(Number(version) || 1, revisionText),
    onSuccess: ({ blob, filename }) => {
      saveBlob(blob, filename)
      setOpen(false)
    },
  })

  const close = () => {
    if (!confirm.isPending) setOpen(false)
  }

  return (
    <>
      <button className="btn btn-primary" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
        {prepare.isPending ? 'Preparazione…' : `⬇ Scarica ${label} (.xlsx)`}
      </button>
      {open && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{label}</h3>
            <div className="form-row">
              <label>Versione</label>
              <input type="number" value={version} onChange={(e) => setVersion(e.target.value)} />
            </div>
            <div className="form-row">
              <label>Descrizione revisione</label>
              <textarea rows={3} value={revisionText} onChange={(e) => setRevisionText(e.target.value)} />
            </div>
            {confirm.isError && <div className="error-banner">{(confirm.error as Error).message}</div>}
            <div className="form-actions">
              <button className="btn" onClick={close} disabled={confirm.isPending}>
                Annulla
              </button>
              <button className="btn btn-primary" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
                {confirm.isPending ? 'Generazione…' : 'Genera e scarica'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <DocumentDownloadButton
            label="Regression Analysis"
            loadMeta={() => api.documents.regressionAnalysisMeta(project.id)}
            download={(version, revisionText) => api.documents.regressionAnalysis(project.id, version, revisionText)}
          />
          <DocumentDownloadButton
            label="Release Report"
            loadMeta={() => api.documents.releaseReportMeta(project.id)}
            download={(version, revisionText) => api.documents.releaseReport(project.id, version, revisionText)}
          />
        </div>

        <p className="muted" style={{ marginTop: '1.25rem', marginBottom: '0.5rem' }}>
          Planning/Execution/Deployment/Release to Market Review: ogni documento include cumulativamente le review dei
          tipi precedenti. Viene compilata solo la Cover (titolo, firmatari, prima revisione); i fogli di review
          restano come nel template, da compilare a mano durante la riunione.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {PPR_TYPES.map(({ docType, label }) => (
            <DocumentDownloadButton
              key={docType}
              label={label}
              loadMeta={() => api.documents.pprMeta(project.id, docType)}
              download={(version, revisionText) => api.documents.ppr(project.id, docType, version, revisionText)}
            />
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
