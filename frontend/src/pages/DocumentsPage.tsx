import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { ImplementedByTask } from '../api/types'
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
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())

  const { data: items } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
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
    <div className="card">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>Documents</h3>
          <span className="sub muted">
            Story e Bug in scope del Backlog, con il parent (Epic) e i Task collegati che li implementano (link Jira
            "is implemented by").
          </span>
        </div>
      </div>

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
              <th>Task collegati (is implemented by)</th>
            </tr>
          </thead>
          <tbody>
            {documentItems.map((item) => {
              const tasks = parseImplementedBy(item.implemented_by_json)
              return (
                <tr key={item.id}>
                  <td>
                    <a href={`https://inpeco.atlassian.net/browse/${item.jira_key}`} target="_blank" rel="noreferrer">
                      {item.jira_key}
                    </a>
                  </td>
                  <td style={{ whiteSpace: 'normal', minWidth: 260 }}>{item.summary ?? <span className="muted">—</span>}</td>
                  <td>{item.issue_type}</td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td>
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
                  <td style={{ whiteSpace: 'normal', minWidth: 320 }}>
                    {tasks.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {tasks.map((task) => (
                          <li key={task.key}>
                            <a
                              href={`https://inpeco.atlassian.net/browse/${task.key}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {task.key}
                            </a>
                            {' — '}
                            {task.summary ?? <span className="muted">—</span>}
                            {' ('}
                            {task.fix_version ?? <span className="muted">nessuna fix version</span>}
                            {')'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              )
            })}
            {documentItems.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nessun item Story/Bug in scope trovato (o nascosto dal filtro tipo).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
