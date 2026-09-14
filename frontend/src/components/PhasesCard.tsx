import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Phase } from '../api/types'

type Props = { projectId: number }

export function PhasesCard({ projectId }: Props) {
  const queryClient = useQueryClient()
  const { data: phases } = useQuery({ queryKey: ['phases', projectId], queryFn: () => api.phases.list(projectId) })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['phases', projectId] })

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Phase> }) => api.phases.update(id, data),
    onSuccess: invalidate,
  })
  const addPhase = useMutation({
    mutationFn: () =>
      api.phases.create(projectId, { name: 'Nuova fase', order: (phases?.length ?? 0) + 1 }),
    onSuccess: invalidate,
  })
  const removePhase = useMutation({
    mutationFn: (id: number) => api.phases.remove(id),
    onSuccess: invalidate,
  })

  const error = update.error ?? addPhase.error ?? removePhase.error

  return (
    <div className="card">
      <h3>Fasi progetto</h3>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Fase</th>
              <th>Pianificata</th>
              <th>Effettiva</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {phases?.map((phase) => (
              <tr key={phase.id}>
                <td className="editable-cell">
                  <input
                    defaultValue={phase.name}
                    onBlur={(e) => e.target.value !== phase.name && update.mutate({ id: phase.id, data: { name: e.target.value } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={phase.planned_date ?? ''}
                    onBlur={(e) => update.mutate({ id: phase.id, data: { planned_date: e.target.value || null } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={phase.actual_date ?? ''}
                    onBlur={(e) => update.mutate({ id: phase.id, data: { actual_date: e.target.value || null } })}
                  />
                </td>
                <td className="editable-cell" style={{ minWidth: 180 }}>
                  <input
                    defaultValue={phase.notes ?? ''}
                    onBlur={(e) => {
                      const value = e.target.value || null
                      if (value !== phase.notes) update.mutate({ id: phase.id, data: { notes: value } })
                    }}
                  />
                </td>
                <td>
                  <button className="btn btn-danger" onClick={() => removePhase.mutate(phase.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {phases?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Nessuna fase definita.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => addPhase.mutate()}>
          + Aggiungi fase
        </button>
      </div>
    </div>
  )
}
