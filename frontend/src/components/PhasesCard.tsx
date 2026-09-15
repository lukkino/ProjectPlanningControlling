import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CartesianGrid, Legend, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import type { Phase } from '../api/types'
import { dateStrToEpochDays, formatEpochDaysAsDate } from '../lib/dates'

type Props = { projectId: number; currentStatus: string }

// Palette categorica validata del progetto (vedi skill data-viz), primi due
// slot fissi: blu, arancio.
const COLOR_PLANNED = '#2a78d6'
const COLOR_ACTUAL = '#eb6834'

type TimelinePoint = { x: number; y: string }

export function PhasesCard({ projectId, currentStatus }: Props) {
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

  // Fase corrente: quella il cui nome corrisponde allo Stato progetto scelto
  // in Dashboard (il menu li' e' popolato proprio dai nomi di queste fasi).
  const currentPhaseIndex = (phases ?? []).findIndex((p) => p.name === currentStatus)

  const phaseNames = (phases ?? []).map((p) => p.name)
  const isPoint = (p: TimelinePoint | { x: number | null; y: string }): p is TimelinePoint => p.x !== null
  const plannedPoints = (phases ?? []).map((p) => ({ x: dateStrToEpochDays(p.planned_date), y: p.name })).filter(isPoint)
  const actualPoints = (phases ?? []).map((p) => ({ x: dateStrToEpochDays(p.actual_date), y: p.name })).filter(isPoint)
  const allEpochs = [...plannedPoints, ...actualPoints].map((p) => p.x)
  const dateDomain: [number, number] =
    allEpochs.length > 0 ? [Math.min(...allEpochs) - 3, Math.max(...allEpochs) + 3] : [0, 1]

  return (
    <div className="card">
      <h3>Fasi progetto</h3>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}
      <div className="grid-3-2">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 140 }}>Fase</th>
                <th>Pianificata</th>
                <th>Effettiva</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {phases?.map((phase, index) => (
                <tr key={phase.id} className={index === currentPhaseIndex ? 'phase-current' : undefined}>
                  <td className="editable-cell">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        defaultValue={phase.name}
                        onBlur={(e) => e.target.value !== phase.name && update.mutate({ id: phase.id, data: { name: e.target.value } })}
                      />
                      {index === currentPhaseIndex && (
                        <span className="badge current" title="Fase in cui ci troviamo ora">
                          Ora
                        </span>
                      )}
                    </div>
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
                  <td className="editable-cell" style={{ minWidth: 140 }}>
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

        {allEpochs.length > 0 ? (
          <div style={{ height: Math.max(160, phaseNames.length * 40) }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                <CartesianGrid stroke="#e1e0d9" horizontal={false} />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={dateDomain}
                  tickFormatter={formatEpochDaysAsDate}
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="y"
                  domain={phaseNames}
                  width={90}
                  tick={{ fontSize: 12 }}
                  allowDuplicatedCategory={false}
                />
                <Tooltip
                  formatter={(value) => formatEpochDaysAsDate(Number(value))}
                  cursor={{ strokeDasharray: '3 3' }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Scatter name="Pianificata" data={plannedPoints} fill={COLOR_PLANNED} />
                <Scatter name="Effettiva" data={actualPoints} fill={COLOR_ACTUAL} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="muted">Imposta almeno una data pianificata o effettiva per vedere il grafico.</p>
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => addPhase.mutate()}>
          + Aggiungi fase
        </button>
      </div>
    </div>
  )
}
