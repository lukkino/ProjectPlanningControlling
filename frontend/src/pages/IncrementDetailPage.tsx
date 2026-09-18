import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { IncrementAndamentoCard } from '../components/IncrementAndamentoCard'
import { IncrementFormModal } from '../components/IncrementFormModal'
import { formatIsoDate } from '../lib/dates'

export function IncrementDetailPage() {
  const { incrementId } = useParams()
  const id = Number(incrementId)
  const [showEdit, setShowEdit] = useState(false)
  const [pickedProjectId, setPickedProjectId] = useState('')
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { data: increment, isLoading } = useQuery({
    queryKey: ['increment', id],
    queryFn: () => api.increments.get(id),
    enabled: !Number.isNaN(id),
  })

  const { data: allProjects } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })

  const remove = useMutation({
    mutationFn: () => api.increments.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['increments'] })
      navigate('/increments')
    },
  })

  // Collega/scollega questo progetto a un increment GIA' ESISTENTE: e' solo
  // un update del campo project_id sul progetto, nessun nuovo increment
  // viene creato. Un progetto appartiene al massimo a un increment.
  const setProject = useMutation({
    mutationFn: (projectId: number | null) => api.increments.update(id, { project_id: projectId }),
    onSuccess: (_saved, projectId) => {
      queryClient.invalidateQueries({ queryKey: ['increment', id] })
      queryClient.invalidateQueries({ queryKey: ['increments'] })
      if (increment?.project?.id) queryClient.invalidateQueries({ queryKey: ['project', increment.project.id] })
      if (projectId) queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  if (isLoading || !increment) return <p className="muted">Caricamento...</p>

  const handleAttach = () => {
    if (!pickedProjectId) return
    setProject.mutate(Number(pickedProjectId))
    setPickedProjectId('')
  }

  const handleDelete = () => {
    if (
      confirm(`Eliminare il progetto "${increment.code}"? L'increment collegato non viene cancellato, resta solo scollegato.`)
    ) {
      remove.mutate()
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
            Progetto
          </div>
          <h1>{increment.code}</h1>
          <div className="sub">
            {formatIsoDate(increment.start_date) ?? 'inizio n.d.'} → {formatIsoDate(increment.end_date) ?? 'fine n.d.'}
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
          <div className="stat-chip green">
            <span className="value">{increment.budget_hours_total.toFixed(0)}</span>
            <span className="label">Budget ore</span>
          </div>
          <div className="stat-chip orange">
            <span className="value">{increment.logged_hours_total.toFixed(0)}</span>
            <span className="label">Ore usate</span>
          </div>
          <div className="stat-chip violet">
            <span className="value">{(increment.percent_budget_used * 100).toFixed(0)}%</span>
            <span className="label">% ore usate su budget</span>
          </div>
          <div className="stat-chip blue">
            <span className="value">{increment.budget_material_total.toFixed(0)} €</span>
            <span className="label">Budget materiali</span>
          </div>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Budget e ore usate sono proprio di questo progetto (dettaglio per voce nell'Andamento sotto): le ore usate
          vengono dall'ultimo snapshot, o dall'increment collegato se l'Andamento è ancora vuoto.
        </p>
      </div>

      <IncrementAndamentoCard incrementId={increment.id} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Increment collegato</h3>

        {!increment.project && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={pickedProjectId} onChange={(e) => setPickedProjectId(e.target.value)} style={{ flex: 1 }}>
              <option value="">Collega un increment già creato...</option>
              {allProjects?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </option>
              ))}
            </select>
            <button className="btn" disabled={!pickedProjectId || setProject.isPending} onClick={handleAttach}>
              Collega
            </button>
          </div>
        )}

        {increment.project && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Increment</th>
                  <th>Scope</th>
                  <th>Inizio</th>
                  <th>Planned finish</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <Link to={`/projects/${increment.project.id}`}>{increment.project.code}</Link>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {increment.project.name}
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'normal', minWidth: 200 }}>
                    {increment.project.scope ?? <span className="muted">-</span>}
                  </td>
                  <td>{formatIsoDate(increment.project.start_date) ?? <span className="muted">-</span>}</td>
                  <td>{formatIsoDate(increment.project.planned_finish_date) ?? <span className="muted">-</span>}</td>
                  <td>
                    <button className="btn" disabled={setProject.isPending} onClick={() => setProject.mutate(null)}>
                      Scollega
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showEdit && <IncrementFormModal increment={increment} onClose={() => setShowEdit(false)} />}
    </div>
  )
}
