import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import type { IncrementBudgetLine } from '../api/types'

type Props = { incrementId: number }

export function IncrementBudgetLinesCard({ incrementId }: Props) {
  const queryClient = useQueryClient()
  const { data: lines } = useQuery({
    queryKey: ['increment-budget-lines', incrementId],
    queryFn: () => api.incrementBudgetLines.list(incrementId),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['increment-budget-lines', incrementId] })
    queryClient.invalidateQueries({ queryKey: ['increment', incrementId] })
  }

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<IncrementBudgetLine> }) =>
      api.incrementBudgetLines.update(id, data),
    onSuccess: invalidate,
  })
  const addLine = useMutation({
    mutationFn: () =>
      api.incrementBudgetLines.create(incrementId, {
        role_name: 'Nuovo ruolo',
        budget_hours: 0,
        order: (lines?.length ?? 0) + 1,
      }),
    onSuccess: invalidate,
  })
  const removeLine = useMutation({
    mutationFn: (id: number) => api.incrementBudgetLines.remove(id),
    onSuccess: invalidate,
  })

  const chartData = (lines ?? []).map((l) => ({ name: l.role_name, ore: l.budget_hours }))
  const error = update.error ?? addLine.error ?? removeLine.error

  return (
    <div className="card">
      <h3>Budget ore per ruolo</h3>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}
      <div className="grid-2">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ruolo</th>
                <th>Ore budget</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines?.map((line) => (
                <tr key={line.id}>
                  <td className="editable-cell">
                    <input
                      defaultValue={line.role_name}
                      onBlur={(e) =>
                        e.target.value !== line.role_name && update.mutate({ id: line.id, data: { role_name: e.target.value } })
                      }
                    />
                  </td>
                  <td className="editable-cell">
                    <input
                      type="number"
                      defaultValue={line.budget_hours}
                      onBlur={(e) => update.mutate({ id: line.id, data: { budget_hours: Number(e.target.value) } })}
                    />
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
                  <td colSpan={3} className="muted">
                    Nessuna riga di budget.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => addLine.mutate()}>
              + Aggiungi ruolo
            </button>
          </div>
        </div>

        {chartData.length > 0 && (
          <div style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="ore" fill="#2f6fed" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )
}
