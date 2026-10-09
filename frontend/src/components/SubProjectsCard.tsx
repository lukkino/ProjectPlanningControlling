import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { IncrementDetail, SubProject } from '../api/types'

type Props = { increment: IncrementDetail }

const fmtHours = (v: number) => v.toLocaleString('it-IT', { maximumFractionDigits: 1 })

// Card "Sotto-progetti" della pagina di un progetto: lo scompone in parti,
// ognuna col suo budget ore e collegabile a un increment diverso (es. una
// maintenance divisa tra piu' increment). Un progetto si collega per intero
// (card "Increment collegato") oppure tramite i sotto-progetti, mai in
// entrambi i modi: finche' e' collegato per intero i sotto-progetti si
// possono definire ma non collegare.
export function SubProjectsCard({ increment }: Props) {
  const queryClient = useQueryClient()
  const { data: allProjects } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })

  // Cambiano il progetto, l'elenco dei progetti (usato per collegarli dagli
  // increment) e gli increment toccati, che mostrano i sotto-progetti
  // collegati e ne sommano il budget.
  const invalidate = (...projectIds: (number | null | undefined)[]) => {
    queryClient.invalidateQueries({ queryKey: ['increment', increment.id] })
    queryClient.invalidateQueries({ queryKey: ['increments'] })
    for (const projectId of projectIds) {
      if (projectId == null) continue
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] })
    }
  }

  const add = useMutation({
    mutationFn: () =>
      api.subProjects.create(increment.id, {
        name: 'Nuovo sotto-progetto',
        budget_hours: 0,
        order: Math.max(0, ...increment.sub_projects.map((s) => s.order)) + 1,
      }),
    onSuccess: () => invalidate(),
  })
  const update = useMutation({
    mutationFn: ({ sub, data }: { sub: SubProject; data: Partial<Pick<SubProject, 'name' | 'budget_hours' | 'project_id'>> }) =>
      api.subProjects.update(sub.id, data),
    onSuccess: (saved, { sub }) => invalidate(sub.project_id, saved.project_id),
  })
  const remove = useMutation({
    mutationFn: (sub: SubProject) => api.subProjects.remove(sub.id),
    onSuccess: (_, sub) => invalidate(sub.project_id),
  })

  const error = add.error ?? update.error ?? remove.error
  const subProjects = increment.sub_projects
  const wholeLinked = increment.project !== null
  const subBudgetTotal = subProjects.reduce((sum, s) => sum + s.budget_hours, 0)
  const unassigned = increment.budget_hours_total - subBudgetTotal

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Sotto-progetti</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Per un progetto che non va per intero su un solo increment (es. una maintenance divisa tra più increment):
        ogni sotto-progetto ha il suo budget ore e si collega a un increment per conto suo. Le ore usate si
        inseriscono a ogni snapshot nello Storico progetto qui sopra.
      </p>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}
      {wholeLinked && subProjects.length > 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          Il progetto è collegato per intero a{' '}
          <Link to={`/projects/${increment.project!.id}`}>{increment.project!.code}</Link>: per collegare i singoli
          sotto-progetti, scollegalo prima da "Increment collegato".
        </p>
      )}

      {subProjects.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>Sotto-progetto</th>
                <th>Budget ore</th>
                <th title="Actual nell'ultimo snapshot dello Storico progetto">Ore usate</th>
                <th style={{ minWidth: 260 }}>Increment collegato</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {subProjects.map((sub) => (
                // key: campi non controllati, vanno ricreati quando i valori salvati cambiano.
                <tr key={`${sub.id}-${sub.name}-${sub.budget_hours}`}>
                  <td className="editable-cell">
                    <input
                      defaultValue={sub.name}
                      aria-label="Nome del sotto-progetto"
                      onBlur={(e) => {
                        const name = e.target.value.trim()
                        if (name && name !== sub.name) update.mutate({ sub, data: { name } })
                        else e.target.value = sub.name
                      }}
                    />
                  </td>
                  <td className="editable-cell">
                    <input
                      type="number"
                      min={0}
                      step="any"
                      defaultValue={sub.budget_hours}
                      aria-label={`Budget ore di ${sub.name}`}
                      style={{ width: 110 }}
                      onBlur={(e) => {
                        const value = Number(e.target.value) || 0
                        if (value !== sub.budget_hours) update.mutate({ sub, data: { budget_hours: value } })
                      }}
                    />
                  </td>
                  <td>
                    {fmtHours(sub.actual_hours)}
                    {sub.budget_hours > 0 && (
                      <span
                        className="muted"
                        style={sub.actual_hours > sub.budget_hours ? { color: 'var(--danger)', fontWeight: 600 } : undefined}
                      >
                        {' '}
                        ({Math.round((sub.actual_hours / sub.budget_hours) * 100)}%)
                      </span>
                    )}
                  </td>
                  <td className="editable-cell">
                    <select
                      value={sub.project_id ?? ''}
                      aria-label={`Increment collegato a ${sub.name}`}
                      disabled={wholeLinked || update.isPending}
                      onChange={(e) =>
                        update.mutate({ sub, data: { project_id: e.target.value ? Number(e.target.value) : null } })
                      }
                    >
                      <option value="">— non collegato —</option>
                      {allProjects?.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.code} · {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className="btn btn-danger"
                      title="Elimina il sotto-progetto"
                      onClick={() => {
                        if (confirm(`Eliminare il sotto-progetto "${sub.name}"?`)) remove.mutate(sub)
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subProjects.length > 0 && (
        <p style={{ fontSize: 13 }}>
          Budget dei sotto-progetti: <strong>{fmtHours(subBudgetTotal)} h</strong> su{' '}
          <strong>{fmtHours(increment.budget_hours_total)} h</strong> di budget ore del progetto
          {unassigned > 0 && <> · {fmtHours(unassigned)} h non ancora assegnate</>}
          {unassigned < 0 && (
            <>
              {' · '}
              <strong style={{ color: 'var(--danger)' }}>{fmtHours(-unassigned)} h oltre il budget del progetto</strong>
            </>
          )}
        </p>
      )}

      <div style={{ marginTop: 10 }}>
        <button className="btn" disabled={add.isPending} onClick={() => add.mutate()}>
          + Aggiungi sotto-progetto
        </button>
      </div>
    </div>
  )
}
