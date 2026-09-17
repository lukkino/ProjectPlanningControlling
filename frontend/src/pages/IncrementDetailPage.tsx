import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { IncrementFormModal } from '../components/IncrementFormModal'
import { ProjectFormModal } from '../components/ProjectFormModal'
import { StatusBadge } from '../components/StatusBadge'
import { formatIsoDate } from '../lib/dates'

export function IncrementDetailPage() {
  const { incrementId } = useParams()
  const id = Number(incrementId)
  const [showEdit, setShowEdit] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { data: increment, isLoading } = useQuery({
    queryKey: ['increment', id],
    queryFn: () => api.increments.get(id),
    enabled: !Number.isNaN(id),
  })

  const backlogQueries = useQueries({
    queries: (increment?.projects ?? []).map((p) => ({
      queryKey: ['backlog', p.id],
      queryFn: () => api.backlog.list(p.id),
    })),
  })

  const remove = useMutation({
    mutationFn: () => api.increments.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['increments'] })
      navigate('/increments')
    },
  })

  if (isLoading || !increment) return <p className="muted">Caricamento...</p>

  const handleDelete = () => {
    if (
      confirm(
        `Eliminare l'increment "${increment.code}"? I progetti collegati non vengono cancellati, restano solo scollegati.`,
      )
    ) {
      remove.mutate()
    }
  }

  const content = increment.projects.flatMap((project, idx) => {
    const items = backlogQueries[idx]?.data ?? []
    return items.map((item) => ({ project, item }))
  })

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{increment.code}</h1>
          <div className="sub">
            {increment.name && `${increment.name} · `}
            Rilascio: {formatIsoDate(increment.release_date) ?? 'data non definita'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setShowEdit(true)}>
            Modifica
          </button>
          <button className="btn btn-danger" onClick={handleDelete}>
            Elimina
          </button>
        </div>
      </div>

      {increment.notes && (
        <div className="card">
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{increment.notes}</p>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Totale increment</h3>
        <div className="stat-chips">
          <div className="stat-chip blue">
            <span className="value">
              {increment.backlog_done}/{increment.backlog_in_scope}
            </span>
            <span className="label">PBI Done</span>
          </div>
          <div className="stat-chip violet">
            <span className="value">{(increment.percent_complete * 100).toFixed(0)}%</span>
            <span className="label">Completamento</span>
          </div>
          <div className="stat-chip green">
            <span className="value">{increment.budget_hours_total.toFixed(0)}</span>
            <span className="label">Budget ore (somma progetti)</span>
          </div>
          <div className="stat-chip orange">
            <span className="value">{increment.logged_hours_total.toFixed(0)}</span>
            <span className="label">Ore usate (somma progetti)</span>
          </div>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Totale calcolato sommando i progetti collegati qui sotto: la rendicontazione ore/spese resta sul singolo
          progetto.
        </p>
      </div>

      <div className="card">
        <div className="page-header" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Progetti collegati</h3>
          <button className="btn" onClick={() => setShowNewProject(true)}>
            + Nuovo progetto in questo increment
          </button>
        </div>
        {increment.by_project.length === 0 && (
          <p className="muted">
            Nessun progetto collegato. Crea un progetto qui sopra, oppure collega un progetto esistente modificandolo
            e scegliendo questo increment.
          </p>
        )}
        {increment.by_project.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Progetto</th>
                  <th>PBI Done</th>
                  <th>Budget ore</th>
                  <th>Ore usate</th>
                </tr>
              </thead>
              <tbody>
                {increment.by_project.map((row) => (
                  <tr key={row.project.id}>
                    <td>
                      <Link to={`/projects/${row.project.id}`}>
                        {row.project.code} · {row.project.name}
                      </Link>
                    </td>
                    <td>
                      {row.backlog_done}/{row.backlog_in_scope}
                    </td>
                    <td>{row.budget_hours_total.toFixed(0)}</td>
                    <td>{row.logged_hours_total.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Contenuto (backlog aggregato)</h3>
        {content.length === 0 && <p className="muted">Nessun item nel backlog dei progetti collegati.</p>}
        {content.length > 0 && (
          <div className="table-wrap table-wrap--scroll">
            <table>
              <thead>
                <tr>
                  <th>Jira</th>
                  <th>Progetto</th>
                  <th>Tipo</th>
                  <th>Sommario</th>
                  <th>Stato</th>
                </tr>
              </thead>
              <tbody>
                {content.map(({ project, item }) => (
                  <tr key={item.id}>
                    <td>{item.jira_key}</td>
                    <td>{project.code}</td>
                    <td>{item.issue_type ?? '-'}</td>
                    <td style={{ whiteSpace: 'normal' }}>{item.summary ?? '-'}</td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showEdit && <IncrementFormModal increment={increment} onClose={() => setShowEdit(false)} />}
      {showNewProject && (
        <ProjectFormModal defaultIncrementId={increment.id} onClose={() => setShowNewProject(false)} />
      )}
    </div>
  )
}
