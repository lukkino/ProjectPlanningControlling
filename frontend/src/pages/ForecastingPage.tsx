import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { ForecastSimulation } from '../api/types'
import { countBacklogStats } from '../lib/backlogStats'
import { useProjectContext } from './useProjectContext'

export function ForecastingPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()

  const { data: simulations } = useQuery({
    queryKey: ['forecasting', project.id],
    queryFn: () => api.forecasting.list(project.id),
  })

  // Stessa query cache di BacklogPage (query key condivisa): serve solo a
  // precompilare #PBI Remaining di default su una nuova simulazione.
  const { data: backlogItems } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })
  const { remainingCount } = countBacklogStats(backlogItems ?? [])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['forecasting', project.id] })

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<ForecastSimulation> }) => api.forecasting.update(id, data),
    onSuccess: invalidate,
  })
  const add = useMutation({
    mutationFn: () =>
      api.forecasting.create(project.id, {
        simulation_date: new Date().toISOString().slice(0, 10),
        pbi_remaining: remainingCount,
      }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.forecasting.remove(id),
    onSuccess: invalidate,
  })

  const num = (v: string) => (v === '' ? null : Number(v))
  const dateOrNull = (v: string) => v || null
  const textOrNull = (v: string) => v.trim() || null

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>Forecasting</h3>
          <span className="sub muted">
            Simulazioni periodiche di throughput usate per proiettare la data di completamento del progetto.
          </span>
        </div>
      </div>

      <div className="table-wrap">
        <table className="forecast-table">
          <colgroup>
            <col style={{ width: '14%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '2%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Note</th>
              <th>Simulation Date</th>
              <th>#PBI Remaining</th>
              <th>#PBI Done</th>
              <th>Planned #PBI Done</th>
              <th>Unplanned #PBI Done</th>
              <th>Traditional Forecasting</th>
              <th>Code Freeze Deadline (100% PBIs Done)</th>
              <th>Chance to meet the deadline (Completion Likelihood)</th>
              <th>85% Completion Date Forecasting</th>
              <th>85% #PBI Completed by Release Deadline Forecasting</th>
              <th>85% Completion Date Forecasting w/ Holidays</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {simulations?.map((sim) => (
              <tr key={sim.id}>
                <td className="editable-cell" style={{ whiteSpace: 'normal', minWidth: 220 }}>
                  <textarea
                    rows={2}
                    defaultValue={sim.note ?? ''}
                    style={{ width: '100%', resize: 'vertical', font: 'inherit', border: 'none', background: 'transparent' }}
                    onBlur={(e) => {
                      const value = textOrNull(e.target.value)
                      if (value !== sim.note) update.mutate({ id: sim.id, data: { note: value } })
                    }}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={sim.simulation_date ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { simulation_date: dateOrNull(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={sim.pbi_remaining ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { pbi_remaining: num(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={sim.pbi_done ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { pbi_done: num(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={sim.planned_pbi_done ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { planned_pbi_done: num(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={sim.unplanned_pbi_done ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { unplanned_pbi_done: num(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    defaultValue={sim.traditional_forecasting ?? ''}
                    placeholder="gg/mm/aaaa o n.a."
                    onBlur={(e) => {
                      const value = textOrNull(e.target.value)
                      if (value !== sim.traditional_forecasting)
                        update.mutate({ id: sim.id, data: { traditional_forecasting: value } })
                    }}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={sim.code_freeze_deadline ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { code_freeze_deadline: dateOrNull(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    step="0.01"
                    defaultValue={sim.completion_likelihood ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { completion_likelihood: num(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={sim.completion_date_85pct ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { completion_date_85pct: dateOrNull(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={sim.pbi_completed_by_deadline_85pct ?? ''}
                    onBlur={(e) =>
                      update.mutate({ id: sim.id, data: { pbi_completed_by_deadline_85pct: num(e.target.value) } })
                    }
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={sim.completion_date_85pct_with_holidays ?? ''}
                    onBlur={(e) =>
                      update.mutate({ id: sim.id, data: { completion_date_85pct_with_holidays: dateOrNull(e.target.value) } })
                    }
                  />
                </td>
                <td>
                  <button className="btn btn-danger" onClick={() => remove.mutate(sim.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {simulations?.length === 0 && (
              <tr>
                <td colSpan={13} className="muted">
                  Nessuna simulazione registrata.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={() => add.mutate()} disabled={add.isPending}>
          + Aggiungi simulazione
        </button>
      </div>
    </div>
  )
}
