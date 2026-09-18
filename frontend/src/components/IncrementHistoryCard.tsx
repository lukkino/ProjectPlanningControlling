import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import type { IncrementBudgetLine, IncrementSnapshot, IncrementSnapshotValue } from '../api/types'
import { formatIsoDate } from '../lib/dates'

type Props = { incrementId: number }

// Stesso blu/arancio gia' usato altrove nell'app per confrontare due serie
// (es. DashboardPage): qui budget vs actual (dell'ultimo snapshot).
const COLOR_BUDGET = '#2f6fed'
const COLOR_ACTUAL = '#eb6834'

// Quante tabelle snapshot (le piu' recenti) restano visibili senza dover
// espandere "Mostra snapshot precedenti".
const VISIBLE_SNAPSHOTS = 2

function formatValue(value: number, isHours: boolean): string {
  if (isHours) return value.toLocaleString('it-IT')
  return `${value.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

function formatDiff(value: number, isHours: boolean): string {
  return value > 0 ? `+${formatValue(value, isHours)}` : formatValue(value, isHours)
}

export function IncrementHistoryCard({ incrementId }: Props) {
  const [showAll, setShowAll] = useState(false)
  const queryClient = useQueryClient()
  const { data: lines } = useQuery({
    queryKey: ['increment-budget-lines', incrementId],
    queryFn: () => api.incrementBudgetLines.list(incrementId),
  })
  const { data: snapshotsAsc } = useQuery({
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

  // snapshotsAsc e' in ordine cronologico (dal backend): qui serve anche
  // dal piu' recente, sia per decidere quali mostrare di default sia per
  // calcolare il diff di ognuno rispetto al precedente.
  const snapshotsDesc = [...(snapshotsAsc ?? [])].reverse()
  const latestSnapshot = snapshotsDesc[0] ?? null
  const visibleSnapshots = showAll ? snapshotsDesc : snapshotsDesc.slice(0, VISIBLE_SNAPSHOTS)
  const hiddenCount = snapshotsDesc.length - visibleSnapshots.length

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
        Budget e Actual sono entrambi il totale cumulativo ad oggi per quella voce, non solo del periodo: un nuovo
        snapshot riparte dai valori del precedente (il budget di solito resta costante, ma può cambiare per una
        revisione budget).
      </p>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}

      <div className="grid-3-2">
        <div>
          {snapshotsDesc.length === 0 && (
            <p className="muted">Nessuno snapshot registrato ancora: creane uno con "+ Nuovo snapshot".</p>
          )}

          {visibleSnapshots.map((snap) => {
            const idxAsc = (snapshotsAsc ?? []).findIndex((s) => s.id === snap.id)
            const prev = idxAsc > 0 ? (snapshotsAsc ?? [])[idxAsc - 1] : null
            const prevByLine = new Map((prev?.values ?? []).map((v) => [v.budget_line_id, v]))
            const valueByLine = new Map(snap.values.map((v) => [v.budget_line_id, v]))

            return (
              <div key={snap.id} className="table-wrap" style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="date"
                      defaultValue={snap.snapshot_date}
                      onBlur={(e) =>
                        e.target.value !== snap.snapshot_date &&
                        updateSnapshot.mutate({ id: snap.id, data: { snapshot_date: e.target.value } })
                      }
                    />
                    <input
                      defaultValue={snap.note ?? ''}
                      placeholder="Nota (opzionale)"
                      style={{ width: 160 }}
                      onBlur={(e) =>
                        e.target.value !== (snap.note ?? '') &&
                        updateSnapshot.mutate({ id: snap.id, data: { note: e.target.value || null } })
                      }
                    />
                  </div>
                  <button className="btn btn-danger" onClick={() => removeSnapshot.mutate(snap.id)}>
                    ✕
                  </button>
                </div>
                <table style={{ tableLayout: 'fixed', width: '100%' }}>
                  <colgroup>
                    <col style={{ width: 190 }} />
                    <col style={{ width: 140 }} />
                    <col style={{ width: 140 }} />
                    <col style={{ width: 150 }} />
                    <col style={{ width: 90 }} />
                    <col style={{ width: 40 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Area</th>
                      <th>Budget</th>
                      <th>Actual</th>
                      <th style={{ whiteSpace: 'normal' }}>Diff previous snapshot</th>
                      <th>% Used</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines?.map((line) => {
                      const value = valueByLine.get(line.id)
                      const prevValue = prevByLine.get(line.id)
                      const diff = (value?.actual_value ?? 0) - (prevValue?.actual_value ?? 0)
                      const pctUsed = value && value.budget_value ? (value.actual_value / value.budget_value) * 100 : null
                      return (
                        <tr key={line.id}>
                          <td style={{ whiteSpace: 'normal' }}>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <input
                                defaultValue={line.category_name}
                                style={{ minWidth: 0 }}
                                onBlur={(e) =>
                                  e.target.value !== line.category_name &&
                                  updateLine.mutate({ id: line.id, data: { category_name: e.target.value } })
                                }
                              />
                              <select
                                value={line.is_hours ? 'hours' : 'money'}
                                onChange={(e) =>
                                  updateLine.mutate({ id: line.id, data: { is_hours: e.target.value === 'hours' } })
                                }
                              >
                                <option value="hours">Ore</option>
                                <option value="money">€</option>
                              </select>
                            </div>
                          </td>
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
                          </td>
                          <td>{formatDiff(diff, line.is_hours)}</td>
                          <td
                            style={{
                              fontWeight: 600,
                              color: pctUsed === null ? undefined : pctUsed > 100 ? 'var(--danger)' : 'var(--success)',
                            }}
                          >
                            {pctUsed === null ? '—' : `${pctUsed.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
                          </td>
                          <td>
                            <button className="btn btn-danger" onClick={() => removeLine.mutate(line.id)}>
                              ✕
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          })}

          {hiddenCount > 0 && !showAll && (
            <button className="btn" onClick={() => setShowAll(true)}>
              Mostra {hiddenCount} snapshot precedenti
            </button>
          )}
          {showAll && snapshotsDesc.length > VISIBLE_SNAPSHOTS && (
            <button className="btn" onClick={() => setShowAll(false)}>
              Nascondi snapshot precedenti
            </button>
          )}
        </div>

        {chartData.length > 0 && (
          <div>
            <h4 style={{ margin: '0 0 8px', fontSize: 13, textAlign: 'center' }}>
              Budget vs Actual — {formatIsoDate(latestSnapshot?.snapshot_date ?? null)}
            </h4>
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
          </div>
        )}
      </div>
    </div>
  )
}
