import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { useRefreshBudget } from '../lib/budget'
import { HoursItemsTable, type HoursItem, type HoursItemInput } from './budgetShared'

type Props = { incrementId: number }

// Budget ore del progetto, in lavorazione: righe per reparto e attivita' con
// le ore per societa', come nel foglio Hours del file di budget. Si
// compilano a mano o dal Capacity Planner (tool); valgono per il progetto
// solo con "Aggiorna ore progetto", che le copia nel Dettaglio budget ore
// progetto (come i materiali). Dopo "Congela budget" si va avanti con le review.
export function HoursCostsCard({ incrementId }: Props) {
  const queryClient = useQueryClient()
  const refreshBudget = useRefreshBudget(incrementId)
  const queryKey = ['hours-costs', incrementId]
  const { data: costs } = useQuery({ queryKey, queryFn: () => api.hoursCosts.list(incrementId) })
  const detailKey = ['hours-detail', incrementId]
  const { data: detail } = useQuery({ queryKey: detailKey, queryFn: () => api.hoursDetail.get(incrementId) })
  const [actionError, setActionError] = useState<string | null>(null)
  const frozen = !!detail?.frozen_at

  const refresh = () => {
    setActionError(null)
    return queryClient.invalidateQueries({ queryKey })
  }
  const onError = (e: Error) => setActionError(e.message)
  const create = useMutation({ mutationFn: (data: HoursItemInput) => api.hoursCosts.create(incrementId, data), onSuccess: refresh, onError })
  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: HoursItemInput }) => api.hoursCosts.update(id, data),
    onSuccess: refresh,
    onError,
  })
  const remove = useMutation({ mutationFn: (id: number) => api.hoursCosts.remove(id), onSuccess: refresh, onError })
  const publish = useMutation({
    mutationFn: () => api.hoursCosts.publish(incrementId, frozen),
    onSuccess: (saved) => {
      setActionError(null)
      queryClient.setQueryData(detailKey, saved)
      refreshBudget()
    },
    onError,
  })

  // Righe cambiate dopo l'ultimo "Aggiorna ore progetto": confronto per
  // attivita', reparto e societa' con il Dettaglio budget ore.
  const fromCosts = (costs ?? [])
    .flatMap((c: HoursItem) =>
      (
        [
          ['SpA', c.spa],
          ['SA', c.sa],
          ['TPM', c.tpm],
        ] as const
      )
        .filter(([, h]) => h)
        .map(([company, h]) => `${c.description}|${c.department}|${company}|${Math.round(h * 100)}`),
    )
    .sort()
    .join('\n')
  const fromDetail = (detail?.rows ?? [])
    .filter((r) => r.hours)
    .map((r) => `${r.name}|${r.department}|${r.company}|${Math.round(r.hours * 100)}`)
    .sort()
    .join('\n')
  const changed = !!costs && !!detail && fromCosts !== fromDetail

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 4, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Budget ore</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Link className="btn" to={`/tools/capacity-planner?progetto=${incrementId}`} title="Calcola le ore con il Capacity Planner (Tools) e copiale qui">
            🧮 Capacity Planner
          </Link>
          <button
            className="btn btn-primary"
            disabled={publish.isPending || !costs}
            title={
              frozen
                ? 'Budget congelato: corregge il budget ore iniziale (errori, attività dimenticate) senza review'
                : 'Copia le righe di adesso nel Dettaglio budget ore progetto'
            }
            onClick={() =>
              (!frozen ||
                confirm(
                  'Il budget è congelato. Correggere il budget ore iniziale con le righe di adesso, senza una review? Usalo per errori o attività dimenticate: le variazioni di budget vere vanno in una review.',
                )) &&
              publish.mutate()
            }
          >
            {publish.isPending ? 'Aggiornamento…' : frozen ? '✎ Correggi ore progetto' : '↑ Aggiorna ore progetto'}
          </button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Le ore del progetto per reparto e attività, divise per società, come nel foglio Hours del file di budget. Si
        inseriscono a mano oppure si calcolano con il Capacity Planner (Tools), che le copia qui. Come per i materiali,
        valgono per il progetto solo con "Aggiorna ore progetto".
      </p>
      {frozen && (
        <p style={{ marginTop: 0, fontSize: 13, color: 'var(--warning)' }}>
          Budget congelato: "Correggi ore progetto" sostituisce il budget ore iniziale con le righe di adesso, senza
          review (per un errore o un'attività dimenticata). Le variazioni di budget vere vanno in una review.
        </p>
      )}
      {changed && (
        <p style={{ marginTop: 0, fontSize: 13, color: 'var(--warning)' }}>
          Ci sono modifiche non ancora riportate nel Dettaglio budget ore progetto.
        </p>
      )}
      {actionError && <div className="error-banner">{actionError}</div>}
      {costs && (
        <HoursItemsTable
          rows={costs}
          footerLabel="Totale ore"
          adding={create.isPending}
          onAdd={(data) => create.mutateAsync(data)}
          onUpdate={(id, data) => update.mutate({ id, data })}
          onRemove={(row) => window.confirm(`Eliminare "${row.description}"?`) && remove.mutate(row.id)}
        />
      )}
    </div>
  )
}
