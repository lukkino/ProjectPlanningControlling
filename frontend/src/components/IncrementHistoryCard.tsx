import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import type { IncrementBudgetLine, IncrementSnapshot, IncrementSnapshotValue } from '../api/types'
import { formatIsoDate } from '../lib/dates'

type Props = { incrementId: number }

// Stesso blu/arancio gia' usato altrove nell'app per confrontare due serie
// (es. DashboardPage): qui budget vs actual (dell'ultimo snapshot).
const COLOR_BUDGET = '#2f6fed'
const COLOR_ACTUAL = '#eb6834'

export function IncrementHistoryCard({ incrementId }: Props) {
  const queryClient = useQueryClient()
  const { data: lines } = useQuery({
    queryKey: ['increment-budget-lines', incrementId],
    queryFn: () => api.incrementBudgetLines.list(incrementId),
  })
  const { data: snapshots } = useQuery({
    queryKey: ['increment-snapshots', incrementId],
    queryFn: () => api.incrementSnapshots.list(incrementId),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['increment-budget-lines', incrementId] })
    queryClient.invalidateQueries({ queryKey: ['increment-snapshots', incrementId] })
    queryClient.invalidateQueries({ queryKey: ['increment', incrementId] })
  }

  const updateLine = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<IncrementBudgetLine> }) =>
      api.incrementBudgetLines.update(id, data),
    onSuccess: invalidate,
  })
  const addLine = useMutation({
    mutationFn: () =>
      api.incrementBudgetLines.create(incrementId, {
        category_name: 'Nuova voce',
        is_hours: false,
        order: (lines?.length ?? 0) + 1,
      }),
    onSuccess: invalidate,
  })
  const removeLine = useMutation({
    mutationFn: (id: number) => api.incrementBudgetLines.remove(id),
    onSuccess: invalidate,
  })

  const updateSnapshot = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<IncrementSnapshot> }) =>
      api.incrementSnapshots.update(id, data),
    onSuccess: invalidate,
  })
  const addSnapshot = useMutation({
    mutationFn: () =>
      api.incrementSnapshots.create(incrementId, { snapshot_date: new Date().toISOString().slice(0, 10) }),
    onSuccess: invalidate,
  })
  const removeSnapshot = useMutation({
    mutationFn: (id: number) => api.incrementSnapshots.remove(id),
    onSuccess: invalidate,
  })
  const updateValue = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<IncrementSnapshotValue> }) =>
      api.incrementSnapshotValues.update(id, data),
    onSuccess: invalidate,
  })

  const error =
    updateLine.error ??
    addLine.error ??
    removeLine.error ??
    updateSnapshot.error ??
    addSnapshot.error ??
    removeSnapshot.error ??
    updateValue.error

  const latestSnapshot = snapshots && snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  const latestByLine = new Map((latestSnapshot?.values ?? []).map((v) => [v.budget_line_id, v]))
  const chartData = (lines ?? []).map((l) => ({
    name: l.category_name,
    budget: latestByLine.get(l.id)?.budget_value ?? 0,
    actual: latestByLine.get(l.id)?.actual_value ?? 0,
  }))

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Storico progetto</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => addLine.mutate()}>
            + Aggiungi voce
          </button>
          <button className="btn btn-primary" onClick={() => addSnapshot.mutate()} disabled={(lines?.length ?? 0) === 0}>
            + Nuovo snapshot
          </button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Ogni valore (Budget e Actual) è il totale cumulativo ad oggi per quella voce, non solo del periodo: un nuovo
        snapshot riparte dai valori del precedente. Sotto ogni Actual, la differenza rispetto allo snapshot
        precedente. Il budget di solito resta costante, ma può cambiare per una revisione budget.
      </p>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}

      <div className="grid-3-2">
        <div className="table-wrap">
          {(!snapshots || snapshots.length === 0) && (
            <p className="muted">Nessuno snapshot registrato ancora: creane uno con "+ Nuovo snapshot".</p>
          )}
          {snapshots && snapshots.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th rowSpan={2}>Data</th>
                  {lines?.map((l) => (
                    <th key={l.id} colSpan={2}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center' }}>
                        <input
                          defaultValue={l.category_name}
                          style={{ width: 90, textTransform: 'none' }}
                          onBlur={(e) =>
                            e.target.value !== l.category_name &&
                            updateLine.mutate({ id: l.id, data: { category_name: e.target.value } })
                          }
                        />
                        <select
                          value={l.is_hours ? 'hours' : 'money'}
                          onChange={(e) => updateLine.mutate({ id: l.id, data: { is_hours: e.target.value === 'hours' } })}
                        >
                          <option value="hours">Ore</option>
                          <option value="money">€</option>
                        </select>
                        <button className="btn btn-danger" style={{ padding: '2px 6px' }} onClick={() => removeLine.mutate(l.id)}>
                          ✕
                        </button>
                      </div>
                    </th>
                  ))}
                  <th rowSpan={2}>Note</th>
                  <th rowSpan={2} />
                </tr>
                <tr>
                  {lines?.map((l) => (
                    <Fragment key={l.id}>
                      <th>Budget</th>
                      <th>Actual</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snap, idx) => {
                  const prev = idx > 0 ? snapshots[idx - 1] : null
                  const prevByLine = new Map((prev?.values ?? []).map((v) => [v.budget_line_id, v]))
                  const valueByLine = new Map(snap.values.map((v) => [v.budget_line_id, v]))
                  return (
                    <tr key={snap.id}>
                      <td className="editable-cell">
                        <input
                          type="date"
                          defaultValue={snap.snapshot_date}
                          onBlur={(e) =>
                            e.target.value !== snap.snapshot_date &&
                            updateSnapshot.mutate({ id: snap.id, data: { snapshot_date: e.target.value } })
                          }
                        />
                      </td>
                      {lines?.map((l) => {
                        const value = valueByLine.get(l.id)
                        const prevValue = prevByLine.get(l.id)
                        const diff = prev && value ? value.actual_value - (prevValue?.actual_value ?? 0) : null
                        return (
                          <Fragment key={l.id}>
                            <td className="editable-cell">
                              <input
                                type="number"
                                defaultValue={value?.budget_value ?? 0}
                                onBlur={(e) =>
                                  value && updateValue.mutate({ id: value.id, data: { budget_value: Number(e.target.value) } })
                                }
                              />
                            </td>
                            <td className="editable-cell">
                              <input
                                type="number"
                                defaultValue={value?.actual_value ?? 0}
                                onBlur={(e) =>
                                  value && updateValue.mutate({ id: value.id, data: { actual_value: Number(e.target.value) } })
                                }
                              />
                              {diff !== null && (
                                <div className="muted" style={{ fontSize: 11 }}>
                                  {diff > 0 ? `+${diff}` : diff}
                                </div>
                              )}
                            </td>
                          </Fragment>
                        )
                      })}
                      <td className="editable-cell">
                        <input
                          defaultValue={snap.note ?? ''}
                          onBlur={(e) =>
                            e.target.value !== (snap.note ?? '') &&
                            updateSnapshot.mutate({ id: snap.id, data: { note: e.target.value || null } })
                          }
                        />
                      </td>
                      <td>
                        <button className="btn btn-danger" onClick={() => removeSnapshot.mutate(snap.id)}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {chartData.length > 0 && (
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="budget" name="Budget" fill={COLOR_BUDGET} radius={[0, 4, 4, 0]} />
                <Bar dataKey="actual" name="Actual" fill={COLOR_ACTUAL} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      {snapshots && snapshots.length > 0 && (
        <p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
          Grafico aggiornato all'ultimo snapshot ({formatIsoDate(latestSnapshot?.snapshot_date ?? null)}).
        </p>
      )}
    </div>
  )
}
