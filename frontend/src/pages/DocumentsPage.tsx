import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { api } from '../api/client'
import type { ImplementedByTask, Project } from '../api/types'
import { StatusBadge } from '../components/StatusBadge'
import { useProjectContext } from './useProjectContext'

const DOCUMENT_TYPES = ['Story', 'Bug']

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
          Compila la Cover (titolo, firmatari, revision history) del template Regression Analysis con i dati di
          questo progetto. Il foglio dati (righe PBI) non è ancora popolato.
        </p>
        <a href={`/api/projects/${project.id}/documents/regression-analysis`} className="btn btn-primary">
          ⬇ Scarica Regression Analysis (.xlsx)
        </a>
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
