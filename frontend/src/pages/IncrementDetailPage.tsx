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
  const [pickedProjectId, setPickedProjectId] = useState('')
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { data: increment, isLoading } = useQuery({
    queryKey: ['increment', id],
    queryFn: () => api.increments.get(id),
    enabled: !Number.isNaN(id),
  })

  const { data: allProjects } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const { data: allIncrements } = useQuery({ queryKey: ['increments'], queryFn: api.increments.list })

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

  // Collega/scollega un increment GIA' ESISTENTE a questo progetto: e' solo
  // un update del campo increment_id sull'increment, nessun nuovo increment
  // viene creato. Usato sia dal picker sotto sia dal bottone "Scollega".
  const setProjectIncrement = useMutation({
    mutationFn: ({ projectId, incrementId: newIncrementId }: { projectId: number; incrementId: number | null }) =>
      api.projects.update(projectId, { increment_id: newIncrementId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['increment', id] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  if (isLoading || !increment) return <p className="muted">Caricamento...</p>

  const linkedIds = new Set(increment.projects.map((p) => p.id))
  const incrementCodeById = new Map((allIncrements ?? []).map((inc) => [inc.id, inc.code]))
  const attachableProjects = (allProjects ?? []).filter((p) => !linkedIds.has(p.id))

  const handleAttach = () => {
    if (!pickedProjectId) return
    setProjectIncrement.mutate({ projectId: Number(pickedProjectId), incrementId: increment.id })
    setPickedProjectId('')
  }

  const handleDelete = () => {
    if (
      confirm(
        `Eliminare il progetto "${increment.code}"? Gli increment collegati non vengono cancellati, restano solo scollegati.`,
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
            Rilascio: {formatIsoDate(increment.release_date) ?? 'data non definita'}
            {increment.notes && ` · ${increment.notes}`}
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

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Totale progetto</h3>
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
            <span className="label">Budget ore (somma increment)</span>
          </div>
          <div className="stat-chip orange">
            <span className="value">{increment.logged_hours_total.toFixed(0)}</span>
            <span className="label">Ore usate (somma increment)</span>
          </div>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Totale calcolato sommando gli increment collegati qui sotto: la rendicontazione ore/spese resta sul
          singolo increment.
        </p>
      </div>

      <div className="card">
        <div className="page-header" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Increment collegati</h3>
          <button className="btn" onClick={() => setShowNewProject(true)}>
            + Nuovo increment in questo progetto
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
          <select value={pickedProjectId} onChange={(e) => setPickedProjectId(e.target.value)} style={{ flex: 1 }}>
            <option value="">Collega un increment già creato...</option>
            {attachableProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
                {p.increment_id ? ` (già in ${incrementCodeById.get(p.increment_id) ?? '?'})` : ''}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!pickedProjectId || setProjectIncrement.isPending} onClick={handleAttach}>
            Collega
          </button>
        </div>

        {increment.by_project.length === 0 && (
          <p className="muted">Nessun increment collegato ancora: scegline uno esistente qui sopra.</p>
        )}
        {increment.by_project.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Increment</th>
                  <th>Descrizione</th>
                  <th>Inizio</th>
                  <th>Fine</th>
                  <th>Budget ore</th>
                  <th>Ore usate</th>
                  <th>PBI Done</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {increment.by_project.map((row) => (
                  <tr key={row.project.id}>
                    <td>
                      <Link to={`/projects/${row.project.id}`}>{row.project.code}</Link>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {row.project.name}
                      </div>
                    </td>
                    <td style={{ whiteSpace: 'normal', minWidth: 200 }}>
                      {row.project.scope ?? <span className="muted">-</span>}
                    </td>
                    <td>{formatIsoDate(row.project.start_date) ?? <span className="muted">-</span>}</td>
                    <td>{formatIsoDate(row.project.planned_finish_date) ?? <span className="muted">-</span>}</td>
                    <td>{row.budget_hours_total.toFixed(0)}</td>
                    <td>{row.logged_hours_total.toFixed(0)}</td>
                    <td>
                      {row.backlog_done}/{row.backlog_in_scope}
                    </td>
                    <td>
                      <button
                        className="btn"
                        disabled={setProjectIncrement.isPending}
                        onClick={() => setProjectIncrement.mutate({ projectId: row.project.id, incrementId: null })}
                      >
                        Scollega
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Contenuto (backlog aggregato)</h3>
        {content.length === 0 && <p className="muted">Nessun item nel backlog degli increment collegati.</p>}
        {content.length > 0 && (
          <div className="table-wrap table-wrap--scroll">
            <table>
              <thead>
                <tr>
                  <th>Jira</th>
                  <th>Increment</th>
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
