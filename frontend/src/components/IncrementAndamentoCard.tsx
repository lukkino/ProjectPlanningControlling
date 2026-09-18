import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import type { IncrementBudgetLine, IncrementSnapshot } from '../api/types'

type Props = { incrementId: number }

// Stesso blu/arancio gia' usato altrove nell'app per confrontare due serie
// (es. DashboardPage): qui budget vs actual (dell'ultimo snapshot).
const COLOR_BUDGET = '#2f6fed'
const COLOR_ACTUAL = '#eb6834'

export function IncrementAndamentoCard({ incrementId }: Props) {
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
        budget_value: 0,
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
    mutationFn: ({ id, value }: { id: number; value: number }) => api.incrementSnapshotValues.update(id, value),
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
  const latestValueByLine = new Map((latestSnapshot?.values ?? []).map((v) => [v.budget_line_id, v.actual_value]))
  const chartData = (lines ?? []).map((l) => ({
    name: l.category_name,
    budget: l.budget_value,
    actual: latestValueByLine.get(l.id) ?? 0,
  }))

  return (
    <div className="card">
      <h3>Andamento</h3>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}

      <div className="grid-2">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Voce</th>
                <th>Budget</th>
                <th>Unità</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines?.map((line) => (
                <tr key={line.id}>
                  <td className="editable-cell">
                    <input
                      defaultValue={line.category_name}
                      onBlur={(e) =>
                        e.target.value !== line.category_name &&
                        updateLine.mutate({ id: line.id, data: { category_name: e.target.value } })
                      }
                    />
                  </td>
                  <td className="editable-cell">
                    <input
                      type="number"
                      defaultValue={line.budget_value}
                      onBlur={(e) => updateLine.mutate({ id: line.id, data: { budget_value: Number(e.target.value) } })}
                    />
                  </td>
                  <td className="editable-cell">
                    <select
                      value={line.is_hours ? 'hours' : 'money'}
                      onChange={(e) => updateLine.mutate({ id: line.id, data: { is_hours: e.target.value === 'hours' } })}
                    >
                      <option value="hours">Ore</option>
                      <option value="money">€</option>
                    </select>
                  </td>
                  <td>
                    <button className="btn btn-danger" onClick={() => removeLine.mutate(line.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
              {lines?.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Nessuna voce di budget.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => addLine.mutate()}>
              + Aggiungi voce
            </button>
          </div>
        </div>

        {chartData.length > 0 && (
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="budget" name="Budget" fill={COLOR_BUDGET} radius={[0, 4, 4, 0]} />
                <Bar dataKey="actual" name="Actual" fill={COLOR_ACTUAL} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="page-header" style={{ marginTop: 18, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Storico</h3>
        <button className="btn" onClick={() => addSnapshot.mutate()} disabled={(lines?.length ?? 0) === 0}>
          + Nuovo snapshot
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Ogni valore è il totale cumulativo ad oggi per quella voce (non solo del periodo): sotto ogni valore, la
        differenza rispetto allo snapshot precedente.
      </p>

      {(!snapshots || snapshots.length === 0) && <p className="muted">Nessuno snapshot registrato ancora.</p>}
      {snapshots && snapshots.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                {lines?.map((l) => (
                  <th key={l.id}>{l.category_name}</th>
                ))}
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snap, idx) => {
                const prev = idx > 0 ? snapshots[idx - 1] : null
                const prevByLine = new Map((prev?.values ?? []).map((v) => [v.budget_line_id, v.actual_value]))
                const valueByLineId = new Map(snap.values.map((v) => [v.budget_line_id, v]))
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
                      const value = valueByLineId.get(l.id)
                      const diff = prev && value ? value.actual_value - (prevByLine.get(l.id) ?? 0) : null
                      return (
                        <td key={l.id} className="editable-cell">
                          <input
                            type="number"
                            defaultValue={value?.actual_value ?? 0}
                            onBlur={(e) => value && updateValue.mutate({ id: value.id, value: Number(e.target.value) })}
                          />
                          {diff !== null && (
                            <div className="muted" style={{ fontSize: 11 }}>
                              {diff > 0 ? `+${diff}` : diff}
                            </div>
                          )}
                        </td>
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
        </div>
      )}
    </div>
  )
}
