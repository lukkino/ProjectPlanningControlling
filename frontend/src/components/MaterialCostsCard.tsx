import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { MaterialFields } from '../api/types'
import { useRefreshBudget } from '../lib/budget'
import { MaterialTable } from './budgetShared'

type Props = { incrementId: number }

// Budget materiali del progetto, in lavorazione: righe come nel foglio
// Materials and Expenses del file di budget. Valgono per il progetto solo
// con "Aggiorna materiali progetto", che le copia nel Dettaglio materiali
// progetto (come le ore del Capacity Planner nel Dettaglio budget ore);
// dopo "Congela budget" non si aggiorna piu', si va avanti con le review.
export function MaterialCostsCard({ incrementId }: Props) {
  const queryClient = useQueryClient()
  const refreshBudget = useRefreshBudget(incrementId)
  const queryKey = ['material-costs', incrementId]
  const { data: costs } = useQuery({ queryKey, queryFn: () => api.materialCosts.list(incrementId) })
  const budgetKey = ['material-budget', incrementId]
  const { data: budget } = useQuery({ queryKey: budgetKey, queryFn: () => api.materialCosts.budget(incrementId) })
  const [actionError, setActionError] = useState<string | null>(null)
  const frozen = !!budget?.frozen_at

  const refresh = () => {
    setActionError(null)
    return queryClient.invalidateQueries({ queryKey })
  }
  const onError = (e: Error) => setActionError(e.message)
  type Input = Partial<Omit<MaterialFields, 'amount'>>
  const create = useMutation({ mutationFn: (data: Input) => api.materialCosts.create(incrementId, data), onSuccess: refresh, onError })
  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Input }) => api.materialCosts.update(id, data),
    onSuccess: refresh,
    onError,
  })
  const remove = useMutation({ mutationFn: (id: number) => api.materialCosts.remove(id), onSuccess: refresh, onError })
  const publish = useMutation({
    mutationFn: () => api.materialCosts.publish(incrementId, frozen),
    onSuccess: (saved) => {
      setActionError(null)
      queryClient.setQueryData(budgetKey, saved)
      refreshBudget()
    },
    onError,
  })

  const key = (r: Omit<MaterialFields, 'amount'>) =>
    [r.category, r.section ?? '', r.description, r.unit_cost, r.units, r.modules].join('|')
  // Voci cambiate dopo l'ultimo "Aggiorna materiali progetto".
  const changed = !!costs && !!budget && costs.map(key).join('\n') !== budget.rows.map(key).join('\n')

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 4, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Budget materiali</h3>
        <button
          className="btn btn-primary"
          disabled={publish.isPending || !costs}
          title={
            frozen
              ? 'Budget congelato: corregge il budget materiali iniziale (errori, voci dimenticate) senza review'
              : 'Copia le voci di adesso nel Dettaglio materiali progetto'
          }
          onClick={() =>
            (!frozen ||
              confirm(
                'Il budget è congelato. Correggere il budget materiali iniziale con le voci di adesso, senza una review? Usalo per errori o voci dimenticate: le variazioni di budget vere vanno in una review.',
              )) &&
            publish.mutate()
          }
        >
          {publish.isPending ? 'Aggiornamento…' : frozen ? '✎ Correggi materiali progetto' : '↑ Aggiorna materiali progetto'}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        I materiali e le spese del progetto, come nel foglio Materials and Expenses del file di budget: costo = costo
        unitario × unità per modulo × numero di moduli (per Consultancies e Travel Expenses solo l'importo). Come per le
        ore, valgono per il progetto solo con "Aggiorna materiali progetto".
      </p>
      {frozen && (
        <p style={{ marginTop: 0, fontSize: 13, color: 'var(--warning)' }}>
          Budget congelato: "Correggi materiali progetto" sostituisce il budget materiali iniziale con le voci di
          adesso, senza review (per un errore o una voce dimenticata). Le variazioni di budget vere vanno in una review.
        </p>
      )}
      {changed && (
        <p style={{ marginTop: 0, fontSize: 13, color: 'var(--warning)' }}>
          Ci sono modifiche non ancora riportate nel Dettaglio materiali progetto.
        </p>
      )}
      {actionError && <div className="error-banner">{actionError}</div>}
      {costs && (
        <MaterialTable
          rows={costs}
          onAdd={(data) => create.mutate(data)}
          onUpdate={(id, data) => update.mutate({ id, data })}
          onRemove={(row) => window.confirm(`Eliminare "${row.description}"?`) && remove.mutate(row.id)}
        />
      )}
    </div>
  )
}
