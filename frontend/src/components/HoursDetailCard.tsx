import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { HoursDetail, HoursDetailRow } from '../api/types'
import { departmentLabel, fmtHours, useBudgetCatalog, useRefreshBudget } from '../lib/budget'
import { NumberCell } from './budgetShared'

type Props = { incrementId: number }

// Dettaglio budget ore progetto: il budget ore iniziale, una riga per
// tipologia di risorsa e societa' (SpA/SA/TPM) copiata dal Capacity
// Planner con "Aggiorna ore progetto", col reparto DEV del file di budget;
// sotto, le ore extra delle review di budget e il totale che vale. Dopo
// "Congela budget" il budget iniziale non si modifica piu'.
export function HoursDetailCard({ incrementId }: Props) {
  const queryClient = useQueryClient()
  const refreshBudget = useRefreshBudget(incrementId)
  const { data: catalog } = useBudgetCatalog()
  const queryKey = ['hours-detail', incrementId]
  const { data: detail } = useQuery({ queryKey, queryFn: () => api.hoursDetail.get(incrementId) })
  const { data: reviews } = useQuery({
    queryKey: ['budget-reviews', incrementId],
    queryFn: () => api.budget.reviews(incrementId),
  })

  const updateRow = useMutation({
    mutationFn: ({ rowId, data }: { rowId: number; data: Partial<Pick<HoursDetailRow, 'hours' | 'department'>> }) =>
      api.hoursDetail.updateRow(rowId, data, !!detail?.frozen_at),
    onSuccess: (saved: HoursDetail) => {
      queryClient.setQueryData(queryKey, saved)
      refreshBudget()
    },
  })

  const [correcting, setCorrecting] = useState(false)

  if (!detail) return null
  // Budget congelato: righe in sola lettura, salvo "Correggi" (errori).
  const frozen = !!detail.frozen_at && !correcting
  const { rows } = detail
  const totalResources = rows.reduce((sum, r) => sum + r.resource_count, 0)
  const initial = rows.reduce((sum, r) => sum + r.hours, 0)
  const reviewExtra = (reviews ?? []).map((r) => r.hours_items.reduce((sum, i) => sum + i.spa + i.sa + i.tpm, 0))
  const total = initial + reviewExtra.reduce((sum, v) => sum + v, 0)

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 4, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Dettaglio budget ore progetto</h3>
        {detail.frozen_at && rows.length > 0 && (
          <button
            className="btn"
            title="Corregge a mano ore o reparto del budget iniziale congelato, senza review"
            onClick={() =>
              correcting
                ? setCorrecting(false)
                : confirm(
                    'Correggere a mano il budget ore iniziale congelato, senza una review? Usalo per errori: le variazioni di budget vere vanno in una review.',
                  ) && setCorrecting(true)
            }
          >
            {correcting ? '✓ Fine correzione' : '✎ Correggi'}
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Il budget ore iniziale: una riga per tipologia di risorsa e società, copiata dal Capacity Planner con "Aggiorna
        ore progetto" (il reparto si sceglie lì, ma si può correggere qui). Dopo "Congela budget" cambia con le review
        di budget, o con "Correggi" se c'è un errore. Il totale è il Budget ore del progetto e va negli snapshot del Consumo risorse progetto.
      </p>
      {updateRow.isError && (
        <div className="error-banner">Salvataggio non riuscito: {(updateRow.error as Error).message}</div>
      )}
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Ancora vuoto: compila il Capacity Planner più sotto e premi "Aggiorna ore progetto".
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tipologia di risorsa</th>
                <th>Reparto</th>
                <th>Società</th>
                <th className="text-right">N. risorse</th>
                <th className="text-right">Ore</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td className={frozen ? undefined : 'editable-cell'}>
                    {frozen || !catalog ? (
                      departmentLabel(catalog, row.department)
                    ) : (
                      <select
                        aria-label="Reparto"
                        value={row.department ?? ''}
                        onChange={(e) => updateRow.mutate({ rowId: row.id, data: { department: e.target.value || null } })}
                      >
                        {!row.department && <option value="">— scegli —</option>}
                        {catalog.departments.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.code} {d.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>{row.company}</td>
                  <td className="text-right">{row.resource_count.toLocaleString('it-IT', { maximumFractionDigits: 1 })}</td>
                  <td className={frozen ? 'text-right' : 'editable-cell'}>
                    {frozen ? (
                      fmtHours(row.hours)
                    ) : (
                      <NumberCell
                        value={row.hours}
                        label={`Ore ${row.name}`}
                        onSave={(hours) => hours >= 0 && updateRow.mutate({ rowId: row.id, data: { hours } })}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>
                  <strong>Budget iniziale</strong>
                </td>
                <td className="text-right">
                  <strong>{totalResources.toLocaleString('it-IT', { maximumFractionDigits: 1 })}</strong>
                </td>
                <td className="text-right">
                  <strong>{fmtHours(initial)}</strong>
                </td>
              </tr>
              {(reviews ?? []).map((review, i) => (
                <tr key={review.id}>
                  <td colSpan={4} className="muted">
                    + {review.name} (ore extra)
                  </td>
                  <td className="text-right">{fmtHours(reviewExtra[i])}</td>
                </tr>
              ))}
              {(reviews ?? []).length > 0 && (
                <tr>
                  <td colSpan={4}>
                    <strong>Totale con le review</strong>
                  </td>
                  <td className="text-right">
                    <strong>{fmtHours(total)}</strong>
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
