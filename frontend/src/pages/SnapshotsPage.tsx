import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Snapshot } from '../api/types'
import { countBacklogStats } from '../lib/backlogStats'
import { useProjectContext } from './useProjectContext'

export function SnapshotsPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()

  const { data: snapshots } = useQuery({
    queryKey: ['snapshots', project.id],
    queryFn: () => api.snapshots.list(project.id),
  })

  // Stessa query cache di BacklogPage: serve solo a precompilare i totali
  // di un nuovo snapshot con lo stato ATTUALE del backlog. Una volta creato,
  // lo snapshot e' un valore congelato nel DB: non si ricalcola piu' da
  // solo, resta com'e' finche' non lo modifichi tu a mano.
  const { data: backlogItems } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })
  const { inScopeCount, doneCount, loggedHoursTotal } = countBacklogStats(backlogItems ?? [])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['snapshots', project.id] })
    queryClient.invalidateQueries({ queryKey: ['dashboard', project.id] })
  }

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Snapshot> }) => api.snapshots.update(id, data),
    onSuccess: invalidate,
  })
  const add = useMutation({
    mutationFn: () =>
      api.snapshots.create(project.id, {
        snapshot_date: new Date().toISOString().slice(0, 10),
        logged_hours: loggedHoursTotal,
        pbi_total: inScopeCount,
        pbi_done: doneCount,
      }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.snapshots.remove(id),
    onSuccess: invalidate,
  })

  return (
    <div className="card">
      <h3>Storico avanzamento</h3>
      <p className="muted">
        Registra periodicamente una fotografia dello stato del progetto per tracciarne l'andamento nel tempo (mostrato
        nel grafico della Dashboard).
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Ore effettive</th>
              <th>Ore loggate</th>
              <th>PBI totali</th>
              <th>PBI completati</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {snapshots?.map((s) => (
              <tr key={s.id}>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={s.snapshot_date}
                    onBlur={(e) => update.mutate({ id: s.id, data: { snapshot_date: e.target.value } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={s.actual_hours ?? ''}
                    onBlur={(e) => update.mutate({ id: s.id, data: { actual_hours: e.target.value ? Number(e.target.value) : null } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={s.logged_hours ?? ''}
                    onBlur={(e) => update.mutate({ id: s.id, data: { logged_hours: e.target.value ? Number(e.target.value) : null } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={s.pbi_total ?? ''}
                    onBlur={(e) => update.mutate({ id: s.id, data: { pbi_total: e.target.value ? Number(e.target.value) : null } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={s.pbi_done ?? ''}
                    onBlur={(e) => update.mutate({ id: s.id, data: { pbi_done: e.target.value ? Number(e.target.value) : null } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    defaultValue={s.note ?? ''}
                    onBlur={(e) => update.mutate({ id: s.id, data: { note: e.target.value || null } })}
                  />
                </td>
                <td>
                  <button className="btn btn-danger" onClick={() => remove.mutate(s.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {snapshots?.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nessuno snapshot registrato.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10 }}>
        <button className="btn btn-primary" onClick={() => add.mutate()}>
          + Nuovo snapshot
        </button>
      </div>
    </div>
  )
}
