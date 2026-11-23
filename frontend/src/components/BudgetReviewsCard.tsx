import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { BudgetReview, BudgetReviewHours, MaterialFields } from '../api/types'
import { DateInput } from './DateInput'
import { useRefreshBudget } from '../lib/budget'
import { HoursItemsTable, MaterialTable, TextCell } from './budgetShared'

type Props = { incrementId: number; frozen: boolean }

const MAX_REVIEWS_IN_FILE = 3

// Ore extra di una review: un'attivita' di un reparto, divisa per societa'.
function ReviewHoursTable({
  review,
  onChanged,
  onError,
}: {
  review: BudgetReview
  onChanged: (saved: BudgetReview) => void
  onError: (e: Error) => void
}) {
  const add = useMutation({
    mutationFn: (data: Partial<Omit<BudgetReviewHours, 'id'>>) => api.budget.addReviewHours(review.id, data),
    onSuccess: onChanged,
    onError,
  })
  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Omit<BudgetReviewHours, 'id'>> }) => api.budget.updateReviewHours(id, data),
    onSuccess: onChanged,
    onError,
  })
  const remove = useMutation({ mutationFn: (id: number) => api.budget.removeReviewHours(id), onSuccess: onChanged, onError })
  return (
    <HoursItemsTable
      rows={review.hours_items}
      footerLabel="Ore extra della review"
      adding={add.isPending}
      onAdd={(data) => add.mutateAsync(data)}
      onUpdate={(id, data) => update.mutate({ id, data })}
      onRemove={(item) => window.confirm(`Eliminare "${item.description}"?`) && remove.mutate(item.id)}
    />
  )
}

// Review di budget (foglio Budget Review del file di budget): dopo il
// congelamento, ogni review aggiunge ore extra (per reparto e societa') e
// costi extra (come le righe materiali), anche negativi, con una
// motivazione. Il budget che vale e' cumulativo: iniziale + tutte le review.
export function BudgetReviewsCard({ incrementId, frozen }: Props) {
  const queryClient = useQueryClient()
  const refreshBudget = useRefreshBudget(incrementId)
  const queryKey = ['budget-reviews', incrementId]
  const { data: reviews } = useQuery({ queryKey, queryFn: () => api.budget.reviews(incrementId) })
  const [actionError, setActionError] = useState<string | null>(null)
  const onError = (e: Error) => setActionError(e.message)
  const changed = (saved?: BudgetReview) => {
    setActionError(null)
    if (saved) {
      queryClient.setQueryData<BudgetReview[]>(queryKey, (old) => (old ?? []).map((r) => (r.id === saved.id ? saved : r)))
    }
    queryClient.invalidateQueries({ queryKey })
    refreshBudget()
  }

  const create = useMutation({ mutationFn: () => api.budget.createReview(incrementId, {}), onSuccess: () => changed(), onError })
  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Pick<BudgetReview, 'name' | 'review_date' | 'note'>> }) =>
      api.budget.updateReview(id, data),
    onSuccess: changed,
    onError,
  })
  const remove = useMutation({ mutationFn: (id: number) => api.budget.removeReview(id), onSuccess: () => changed(), onError })
  type MaterialInput = Partial<Omit<MaterialFields, 'amount'>>
  const addMaterial = useMutation({
    mutationFn: ({ reviewId, data }: { reviewId: number; data: MaterialInput }) => api.budget.addReviewMaterial(reviewId, data),
    onSuccess: changed,
    onError,
  })
  const updateMaterial = useMutation({
    mutationFn: ({ id, data }: { id: number; data: MaterialInput }) => api.budget.updateReviewMaterial(id, data),
    onSuccess: changed,
    onError,
  })
  const removeMaterial = useMutation({ mutationFn: (id: number) => api.budget.removeReviewMaterial(id), onSuccess: changed, onError })

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 4, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Review di budget</h3>
        <button
          className="btn btn-primary"
          disabled={!frozen || create.isPending}
          title={frozen ? 'Aggiunge una review al budget congelato' : 'Prima congela il budget (pulsante in alto)'}
          onClick={() => create.mutate()}
        >
          + Nuova review
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Come nel foglio Budget Review del file di budget: una review non riscrive il budget, aggiunge ore extra (per
        reparto e società) e costi extra, anche negativi, con il motivo. Il budget che vale è il budget iniziale più
        tutte le review. Il file di budget ha posto per {MAX_REVIEWS_IN_FILE} review.
      </p>
      {!frozen && (
        <p className="muted" style={{ margin: 0 }}>
          Le review si aggiungono dopo "Congela budget", quando il budget iniziale è definitivo.
        </p>
      )}
      {actionError && <div className="error-banner">{actionError}</div>}
      {(reviews ?? []).length > MAX_REVIEWS_IN_FILE && (
        <div className="error-banner">
          Il file di budget ha posto per {MAX_REVIEWS_IN_FILE} review: l'export non includerà quelle in più.
        </div>
      )}
      {(reviews ?? []).map((review) => (
        <details key={review.id} className="budget-review" open>
          <summary>
            <strong>{review.name}</strong>
            <span className="muted">
              {' '}
              · {review.hours_items.length} righe ore, {review.material_items.length} righe costi
            </span>
          </summary>
          <div className="budget-review-head">
            <label>
              <span className="muted">Nome</span>
              <TextCell value={review.name} label="Nome della review" onSave={(name) => update.mutate({ id: review.id, data: { name } })} />
            </label>
            <label>
              <span className="muted">Data</span>
              <DateInput value={review.review_date} onChange={(review_date) => update.mutate({ id: review.id, data: { review_date } })} />
            </label>
            <label style={{ flex: 1 }}>
              <span className="muted">Motivo della review</span>
              <input
                key={review.note ?? ''}
                defaultValue={review.note ?? ''}
                placeholder="es. Estensione scope Barcellona"
                onBlur={(e) => {
                  const note = e.target.value.trim() || null
                  if (note !== review.note) update.mutate({ id: review.id, data: { note } })
                }}
              />
            </label>
            <button
              className="btn btn-danger"
              onClick={() => window.confirm(`Eliminare "${review.name}" e le sue righe?`) && remove.mutate(review.id)}
            >
              Elimina review
            </button>
          </div>
          <h4 style={{ margin: '12px 0 6px' }}>Ore extra</h4>
          <ReviewHoursTable review={review} onChanged={changed} onError={onError} />
          <h4 style={{ margin: '12px 0 6px' }}>Costi extra</h4>
          <MaterialTable
            rows={review.material_items}
            onAdd={(data) => addMaterial.mutate({ reviewId: review.id, data })}
            onUpdate={(id, data) => updateMaterial.mutate({ id, data })}
            onRemove={(row) => window.confirm(`Eliminare "${row.description}"?`) && removeMaterial.mutate(row.id)}
          />
        </details>
      ))}
    </div>
  )
}
