import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { HoursDetail, HoursDetailRow } from '../api/types'

type Props = { incrementId: number }

const fmt = (value: number) => value.toLocaleString('it-IT', { maximumFractionDigits: 1 })

// Ore da un campo di input: vuoto = null (cella svuotata), accetta anche la
// virgola decimale; non valido o negativo = invariato (undefined).
function parseHours(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (!trimmed) return null
  const n = Number(trimmed.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

// Dettaglio budget ore progetto: le ore per tipologia di risorsa, copiate dal
// Calcolatore ore progetto col suo pulsante "Aggiorna ore progetto", e
// accanto le colonne di revisione (Review 1, Review 2...) con le ore
// rivedute, inserite a mano.
export function HoursDetailCard({ incrementId }: Props) {
  const queryClient = useQueryClient()
  const queryKey = ['hours-detail', incrementId]
  const { data: detail } = useQuery({ queryKey, queryFn: () => api.hoursDetail.get(incrementId) })

  const save = (saved: HoursDetail) => queryClient.setQueryData(queryKey, saved)

  const addReview = useMutation({ mutationFn: () => api.hoursDetail.addReview(incrementId), onSuccess: save })
  const renameReview = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.hoursDetail.renameReview(id, name),
    onSuccess: save,
  })
  const removeReview = useMutation({
    mutationFn: (id: number) => api.hoursDetail.removeReview(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })
  const setHours = useMutation({
    mutationFn: ({ reviewId, rowId, hours }: { reviewId: number; rowId: number; hours: number | null }) =>
      api.hoursDetail.setReviewHours(reviewId, rowId, hours),
    onSuccess: save,
  })

  const setRowHours = useMutation({
    mutationFn: ({ rowId, hours }: { rowId: number; hours: number }) => api.hoursDetail.setRowHours(rowId, hours),
    onSuccess: save,
  })

  const error = addReview.error ?? renameReview.error ?? removeReview.error ?? setHours.error ?? setRowHours.error

  if (!detail) return null

  const { rows, reviews } = detail
  const totalResources = rows.reduce((sum, r) => sum + r.resource_count, 0)
  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0)
  // Totale di una revisione: solo se almeno una cella e' compilata.
  const reviewTotal = (reviewId: number) => {
    const values = rows.map((r) => r.review_hours[reviewId]).filter((v): v is number => v !== undefined)
    return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0)
  }
  const cellKey = (row: HoursDetailRow, reviewId: number) => `${row.id}|${reviewId}|${row.review_hours[reviewId] ?? ''}`

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Dettaglio budget ore progetto</h3>
        <button className="btn" disabled={addReview.isPending} onClick={() => addReview.mutate()}>
          + Aggiungi review
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        Le ore per tipologia di risorsa vengono dal Capacity Planner (più in basso), quando premi "Aggiorna
        ore progetto": puoi correggerle a mano, ad esempio per arrotondarle. Nelle colonne di review inserisci le ore
        rivedute.
      </p>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}

      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Nessun dettaglio ancora: prepara i calcoli nel Capacity Planner e premi "Aggiorna ore progetto".
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>Tipologia di risorsa</th>
                <th className="text-right">N. risorse</th>
                <th className="text-right">Ore</th>
                {reviews.map((review) => (
                  <th key={`${review.id}|${review.name}`} className="editable-cell" style={{ minWidth: 120 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input
                        defaultValue={review.name}
                        aria-label="Nome della review"
                        style={{ fontWeight: 600 }}
                        onBlur={(e) => {
                          const value = e.target.value.trim()
                          if (value && value !== review.name) renameReview.mutate({ id: review.id, name: value })
                          else e.target.value = review.name
                        }}
                      />
                      <button
                        className="link-btn"
                        title="Elimina la review"
                        onClick={() =>
                          confirm(`Eliminare la colonna "${review.name}" con le sue ore?`) && removeReview.mutate(review.id)
                        }
                      >
                        ✕
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td className="text-right">{fmt(row.resource_count)}</td>
                  {/* key: campo non controllato, va ricreato quando le ore salvate cambiano. */}
                  <td key={`${row.id}|${row.hours}`} className="editable-cell">
                    <input
                      type="text"
                      inputMode="decimal"
                      className="text-right"
                      style={{ fontWeight: 600 }}
                      defaultValue={fmt(row.hours)}
                      title="Ore dal Capacity Planner: puoi correggerle (es. arrotondarle)"
                      aria-label={`Ore ${row.name}`}
                      onBlur={(e) => {
                        // Il campo mostra le ore col separatore delle migliaia ("2.885").
                        const hours = parseHours(e.target.value.replace(/\.(?=\d{3}(\D|$))/g, ''))
                        if (hours !== null && hours !== undefined && hours !== row.hours)
                          setRowHours.mutate({ rowId: row.id, hours })
                        else e.target.value = fmt(row.hours)
                      }}
                    />
                  </td>
                  {reviews.map((review) => (
                    <td key={cellKey(row, review.id)} className="editable-cell">
                      <input
                        type="text"
                        inputMode="decimal"
                        className="text-right"
                        placeholder="-"
                        defaultValue={row.review_hours[review.id] ?? ''}
                        aria-label={`${review.name}: ore ${row.name}`}
                        onBlur={(e) => {
                          const hours = parseHours(e.target.value)
                          const current = row.review_hours[review.id] ?? null
                          if (hours !== undefined && hours !== current)
                            setHours.mutate({ reviewId: review.id, rowId: row.id, hours })
                          else e.target.value = current === null ? '' : String(current)
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <strong>Totale</strong>
                </td>
                <td className="text-right">
                  <strong>{fmt(totalResources)}</strong>
                </td>
                <td className="text-right">
                  <strong>{fmt(totalHours)} h</strong>
                </td>
                {reviews.map((review) => {
                  const total = reviewTotal(review.id)
                  return (
                    <td key={review.id} className="text-right">
                      <strong>{total === null ? '—' : `${fmt(total)} h`}</strong>
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
